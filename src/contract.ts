import {
  ABICoder, Arguments, FunctionCall, Script, serializeState, State, bsv, DEFAULT_FLAGS, resolveType, path2uri, isStructType, getStructNameByType, isArrayType,
  Struct, SupportedParamType, StructObject, ScryptType, BasicScryptType, ValueType, TypeResolver, arrayTypeAndSize, resolveStaticConst, toLiteralArrayType,
  StructEntity, ABIEntity, OpCode, CompileResult, desc2CompileResult, AliasEntity, buildContractState, ABIEntityType, checkArray
} from './internal';


export interface TxContext {
  tx?: any;
  inputIndex?: number;
  inputSatoshis?: number;
  opReturn?: string;
}


export type VerifyError = string;


export interface VerifyResult {
  success: boolean;
  error?: VerifyError;
}

export interface ContractDescription {
  version: number;
  compilerVersion: string;
  buildType: string;
  contract: string;
  md5: string;
  structs: Array<StructEntity>;
  alias: Array<AliasEntity>
  abi: Array<ABIEntity>;
  asm: string;
  hex: string;
  file: string;
  sources: Array<string>;
  sourceMap: Array<string>;
}

export type AsmVarValues = { [key: string]: string }
export type StepIndex = number;

export class AbstractContract {

  public static contractName: string;
  public static abi: ABIEntity[];
  public static asm: string;
  public static abiCoder: ABICoder;
  public static opcodes?: OpCode[];
  public static file: string;
  public static structs: StructEntity[];
  public static types: Record<string, typeof ScryptType>;
  public static asmContract: boolean;
  public static staticConst: Record<string, number>;

  public static typeResolver: TypeResolver;

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  constructor(...ctorParams: SupportedParamType[]) {
  }

  [key: string]: any;

  scriptedConstructor: FunctionCall;
  calls: Map<string, FunctionCall> = new Map();
  asmArgs: AsmVarValues | null = null;
  asmTemplateArgs: Map<string, string> = new Map();

  get lockingScript(): Script {

    if (this.dataPart) {
      const lsHex = this.codePart.toHex() + this.dataPart.toHex();
      return bsv.Script.fromHex(lsHex);
    }

    const lsASM = this.scriptedConstructor.toASM();

    return bsv.Script.fromASM(lsASM.trim());
  }

  private _txContext?: TxContext;

  set txContext(txContext: TxContext) {
    this._txContext = txContext;
  }

  get txContext(): TxContext {
    return this._txContext;
  }

  get typeResolver(): TypeResolver {
    const typeResolver = Object.getPrototypeOf(this).constructor.typeResolver as TypeResolver;
    return typeResolver;
  }

  get allTypes(): Record<string, typeof ScryptType> {
    const allTypes = Object.getPrototypeOf(this).constructor.types as Record<string, typeof ScryptType>;
    return allTypes;
  }

  // replace assembly variables with assembly values
  replaceAsmVars(asmVarValues: AsmVarValues): void {
    this.asmArgs = asmVarValues;
    this.scriptedConstructor.init(asmVarValues);
  }

  static findSrcInfo(interpretStates: any[], opcodes: OpCode[], stepIndex: number, opcodesIndex: number): OpCode | undefined {
    while (--stepIndex > 0 && --opcodesIndex > 0) {
      if (opcodes[opcodesIndex].pos && opcodes[opcodesIndex].pos.file !== 'std' && opcodes[opcodesIndex].pos.line > 0 && interpretStates[stepIndex].step.fExec) {
        return opcodes[opcodesIndex];
      }
    }
  }

  getTypeClassByType(type: string): typeof ScryptType {
    const types: typeof ScryptType[] = Object.getPrototypeOf(this).constructor.types;

    if (isStructType(type)) {
      const structName = getStructNameByType(type);
      if (Object.prototype.hasOwnProperty.call(types, structName)) {
        return types[structName];
      }
    } else {
      return types[type];
    }
  }


  /**
   * @param states an object. Each key of the object is the name of a state property, and each value is the value of the state property.
   * @returns a locking script that includes the new states. If you only provide some but not all state properties, other state properties are not modified when calculating the locking script.
   */
  getNewStateScript(states: Record<string, SupportedParamType>): Script {

    const stateArgs = this.ctorArgs().filter(arg => arg.state);
    const contractName = Object.getPrototypeOf(this).constructor.contractName;
    if (stateArgs.length === 0) {
      throw new Error(`Contract ${contractName} does not have any stateful property`);
    }

    const resolveKeys: string[] = [];
    const newState: Arguments = stateArgs.map(arg => {
      const finalType = this.typeResolver(arg.type);
      if (Object.prototype.hasOwnProperty.call(states, arg.name)) {
        resolveKeys.push(arg.name);
        if (isArrayType(finalType)) {
          const array = states[arg.name] as SupportedParamType[];
          if (!checkArray(array, finalType)) {
            throw new Error(`stateful property ${arg.name} should be ${arg.type}`);
          }
        } else if (isStructType(finalType)) {

          if (states[arg.name] instanceof Struct) {
            const st = states[arg.name] as Struct;
            if (finalType != st.finalType) {
              throw new Error(`stateful property ${arg.name} expect struct ${getStructNameByType(finalType)} but got ${st.type}`);
            }
          } else {
            throw new Error(`stateful property ${arg.name} expect struct ${getStructNameByType(finalType)} but got ${states[arg.name]}`);
          }
        }

        return Object.assign(
          {
            ...arg
          },
          {
            value: states[arg.name]
          }
        );
      } else {
        return arg;
      }
    });


    Object.keys(states).forEach(key => {
      if (resolveKeys.indexOf(key) === -1) {
        throw new Error(`Contract ${contractName} does not have stateful property ${key}`);
      }
    });

    return bsv.Script.fromHex(this.codePart.toHex() + buildContractState(newState, this.typeResolver));
  }

  run_verify(unlockingScriptASM: string, txContext?: TxContext, args?: Arguments): VerifyResult {
    const txCtx: TxContext = Object.assign({}, this._txContext || {}, txContext || {});

    const us = bsv.Script.fromASM(unlockingScriptASM.trim());
    const ls = this.lockingScript;
    const tx = txCtx.tx;
    const inputIndex = txCtx.inputIndex || 0;
    const inputSatoshis = txCtx.inputSatoshis || 0;


    bsv.Script.Interpreter.MAX_SCRIPT_ELEMENT_SIZE = Number.MAX_SAFE_INTEGER;
    bsv.Script.Interpreter.MAXIMUM_ELEMENT_SIZE = Number.MAX_SAFE_INTEGER;


    const bsi = bsv.Script.Interpreter();

    let stepCounter: StepIndex = 0;
    const interpretStates: { step: any, mainstack: any, altstack: any }[] = [];
    bsi.stepListener = function (step: any, stack: any[], altstack: any[]) {
      interpretStates.push({ mainstack: stack, altstack: altstack, step: step });
      stepCounter++;
    };


    const opcodes: OpCode[] = Object.getPrototypeOf(this).constructor.opcodes;

    const result = bsi.verify(us, ls, tx, inputIndex, DEFAULT_FLAGS, new bsv.crypto.BN(inputSatoshis));

    let error = result ? '' : `VerifyError: ${bsi.errstr}`;



    // some time there is no opcodes, such as when sourcemap flag is disabled. 
    if (opcodes) {
      const offset = unlockingScriptASM.trim().split(' ').length;
      // the complete script may have op_return and data, but compiled output does not have it. So we need to make sure the index is in boundary.

      const lastStepIndex = stepCounter - 1;

      if (typeof this._dataPart === 'string') {
        opcodes.push({ opcode: 'OP_RETURN', stack: [] });
        const dp = this._dataPart.trim();
        if (dp) {
          dp.split(' ').forEach(data => {
            opcodes.push({ opcode: data, stack: [] });
          });
        }
      } else if (AbstractContract.isStateful(this)) {
        opcodes.push({ opcode: 'OP_RETURN', stack: [] });
        const stateHex = this.dataPart.toHex();
        const dp = bsv.Script.fromHex(stateHex).toASM();
        dp.split(' ').forEach(data => {
          opcodes.push({ opcode: data, stack: [] });
        });
      }

      const opcodeIndex = lastStepIndex - offset;


      if (!result && opcodes[opcodeIndex]) {

        const opcode = opcodes[opcodeIndex];

        if (!opcode.pos || opcode.pos.file === 'std') {

          const srcInfo = AbstractContract.findSrcInfo(interpretStates, opcodes, lastStepIndex, opcodeIndex);

          if (srcInfo) {
            opcode.pos = srcInfo.pos;
          }
        }

        // in vscode termianal need to use [:] to jump to file line, but here need to use [#] to jump to file line in output channel.
        if (opcode.pos) {
          error = `VerifyError: ${bsi.errstr} \n\t[Go to Source](${path2uri(opcode.pos.file)}#${opcode.pos.line})  fails at ${opcode.opcode}\n`;

          if (args && ['OP_CHECKSIG', 'OP_CHECKSIGVERIFY', 'OP_CHECKMULTISIG', 'OP_CHECKMULTISIGVERIFY'].includes(opcode.opcode)) {
            if (!txCtx) {
              throw new Error('should provide txContext when verify');
            } if (!tx) {
              throw new Error('should provide txContext.tx when verify');
            }
          }
        }
      }
    }

    return {
      success: result,
      error: error
    };
  }

  private _dataPart: string | undefined;

  set dataPart(dataInScript: Script | undefined) {
    throw new Error('Setter for dataPart is not available. Please use: setDataPart() instead');
  }

  get dataPart(): Script | undefined {

    const state = buildContractState(this.ctorArgs(), this.typeResolver);

    if (state) {
      return bsv.Script.fromHex(state);
    }

    return this._dataPart !== undefined ? bsv.Script.fromASM(this._dataPart) : undefined;
  }

  setDataPart(state: State | string): void {
    if (typeof state === 'string') {
      // TODO: validate hex string
      this._dataPart = state.trim();
    } else {
      this._dataPart = serializeState(state);
    }
  }

  get codePart(): Script {
    const codeASM = this.scriptedConstructor.toASM();
    // note: do not trim the trailing space
    return bsv.Script.fromASM(codeASM + ' OP_RETURN');
  }

  static getAsmVars(contractAsm, instAsm): AsmVarValues | null {
    const regex = /(\$\S+)/g;
    const vars = contractAsm.match(regex);
    if (vars === null) {
      return null;
    }
    const asmArray = contractAsm.split(/\s/g);
    const lsASMArray = instAsm.split(/\s/g);
    const result = {};
    for (let i = 0; i < asmArray.length; i++) {
      for (let j = 0; j < vars.length; j++) {
        if (vars[j] === asmArray[i]) {
          result[vars[j].replace('$', '')] = lsASMArray[i];
        }
      }
    }
    return result;
  }

  public arguments(pubFuncName: string): Arguments {
    if (pubFuncName === 'constructor') {
      return this.scriptedConstructor.args;
    }

    if (this.calls.has(pubFuncName)) {
      return this.calls.get(pubFuncName).args;
    }

    return [];
  }

  public ctorArgs(): Arguments {
    return this.arguments('constructor');
  }

  static fromASM(asm: string): AbstractContract {
    return null;
  }

  static fromHex(hex: string): AbstractContract {
    return null;
  }
  static fromTransaction(hex: string, outputIndex = 0): AbstractContract {
    return null;
  }
  static isStateful(contract: AbstractContract): boolean {
    const abi: Array<ABIEntity> = Object.getPrototypeOf(contract).constructor.abi;
    const constructorABI = abi.filter(entity => entity.type === ABIEntityType.CONSTRUCTOR)[0];
    return constructorABI.params.findIndex(p => p['state'] === true) > -1;
  }
}


const invalidMethodName = ['arguments', 'setDataPart', 'run_verify', 'replaceAsmVars', 'asmVars', 'asmArguments', 'dataPart', 'lockingScript', 'txContext'];

export function buildContractClass(desc: CompileResult | ContractDescription): typeof AbstractContract {

  if (!desc.contract) {
    throw new Error('missing field `contract` in description');
  }

  if (!desc.abi) {
    throw new Error('missing field `abi` in description');
  }

  if (!desc.asm) {
    throw new Error('missing field `asm` in description');
  }

  if (!desc['errors']) {
    desc = desc2CompileResult(desc as ContractDescription);
  } else {
    desc = desc as CompileResult;
  }



  const ContractClass = class Contract extends AbstractContract {
    constructor(...ctorParams: SupportedParamType[]) {
      super();
      if (!Contract.asmContract) {
        this.scriptedConstructor = Contract.abiCoder.encodeConstructorCall(this, Contract.asm, ...ctorParams);
      }
    }

    //When create a contract instance using UTXO, 
    //use fromHex or fromASM because you do not know the parameters of constructor.

    /**
     * Create a contract instance using UTXO asm
     * @param hex 
     */
    static fromASM(asm: string) {
      return ContractClass.fromHex(bsv.Script.fromASM(asm).toHex());
    }

    /**
     * Create a contract instance using UTXO hex
     * @param hex 
     */
    static fromHex(hex: string) {
      Contract.asmContract = true;
      const obj = new this();
      Contract.asmContract = false;
      obj.scriptedConstructor = Contract.abiCoder.encodeConstructorCallFromRawHex(obj, Contract.asm, hex);
      return obj;
    }


    /**
     * Create a contract instance using raw Transaction
     * @param hex 
     */
    static fromTransaction(hex: string, outputIndex = 0) {
      const tx = new bsv.Transaction(hex);
      return ContractClass.fromHex(tx.outputs[outputIndex].script.toHex());
    }

    /**
     * Get the parameter of the constructor and inline asm vars,
     * all values is hex string, need convert it to number or bytes on using
     */
    get asmVars(): AsmVarValues | null {
      return AbstractContract.getAsmVars(Contract.asm, this.scriptedConstructor.toASM());
    }

    get asmArguments(): AsmVarValues | null {
      //TODO: @deprecate AbstractContract.getAsmVars , using asmArguments

      return null;
    }

  };


  const staticConst = desc.staticConst || {};
  ContractClass.typeResolver = buildTypeResolver(desc.contract, desc.alias || [], desc.structs || [], staticConst);

  ContractClass.contractName = desc.contract;
  ContractClass.abi = desc.abi;
  ContractClass.asm = desc.asm.map(item => item['opcode'].trim()).join(' ');
  ContractClass.abiCoder = new ABICoder(desc.abi, ContractClass.typeResolver);
  ContractClass.opcodes = desc.asm;
  ContractClass.file = desc.file;
  ContractClass.structs = desc.structs;
  ContractClass.staticConst = staticConst;
  ContractClass.types = buildTypeClasses(desc);


  ContractClass.abi.forEach(entity => {
    if (invalidMethodName.indexOf(entity.name) > -1) {
      throw new Error(`Method name [${entity.name}] is used by scryptlib now, Pelease change you contract method name!`);
    }


    if (entity.type === 'constructor') {

      entity.params.forEach(p => {
        Object.defineProperty(ContractClass.prototype, p.name, {
          get() {
            const arg = this.ctorArgs().find(arg => {
              return arg.name === p.name;
            });

            if (arg) {
              return arg.value;
            } else {
              throw new Error(`property ${p.name} does not exists`);
            }
          },
          set(value: SupportedParamType) {
            const arg = this.ctorArgs().find(arg => {
              return arg.name === p.name;
            });

            if (arg) {
              arg.value = value;
            } else {
              throw new Error(`property ${p.name} does not exists`);
            }
          }
        });
      });

    }

    ContractClass.prototype[entity.name] = function (...args: SupportedParamType[]): FunctionCall {
      const call = ContractClass.abiCoder.encodePubFunctionCall(this, entity.name, args);
      this.calls.set(entity.name, call);
      return call;
    };
  });

  return ContractClass;
}



/**
 * @deprecated use buildTypeClasses
 * @param desc CompileResult or ContractDescription
 */
export function buildStructsClass(desc: CompileResult | ContractDescription): Record<string, typeof Struct> {

  const structTypes: Record<string, typeof Struct> = {};

  const structs: StructEntity[] = desc.structs || [];
  const alias: AliasEntity[] = desc.alias || [];
  const finalTypeResolver = buildTypeResolver(desc.contract, alias, structs, desc['staticConst'] || {});
  structs.forEach(element => {
    const name = element.name;

    Object.assign(structTypes, {
      [name]: class extends Struct {
        constructor(o: StructObject) {
          super(o);
          this._typeResolver = finalTypeResolver; //we should assign this before bind
          this.bind();
        }
      }
    });

    structTypes[name].structAst = element;
  });

  return structTypes;
}



export function buildTypeClasses(descOrClas: CompileResult | ContractDescription | typeof AbstractContract): Record<string, typeof ScryptType> {

  if (Object.prototype.hasOwnProperty.call(descOrClas, 'types')) {
    const CLASS = descOrClas as typeof AbstractContract;
    return CLASS.types;
  }

  const desc = descOrClas as CompileResult | ContractDescription;

  const structClasses = buildStructsClass(desc);
  const allTypeClasses: Record<string, typeof ScryptType> = {};
  const alias: AliasEntity[] = desc.alias || [];
  const structs: StructEntity[] = desc.structs || [];
  const finalTypeResolver = buildTypeResolver(desc.contract, alias, structs, desc['staticConst'] || {});
  alias.forEach(element => {
    const finalType = finalTypeResolver(element.name);
    if (isStructType(finalType)) {
      const type = getStructNameByType(finalType);
      Object.assign(allTypeClasses, {
        [element.name]: class extends structClasses[type] {
          constructor(o: StructObject) {
            super(o);
            this._type = element.name;
            this._typeResolver = finalTypeResolver;
          }
        }
      });
    } else if (isArrayType(finalType)) {
      //not need to build class type for array, we only build class type for array element
    } else {
      const C = BasicScryptType[finalType];
      if (C) {
        const aliasClass = class extends C {
          constructor(o: ValueType) {
            super(o);
            this._type = element.name;
            this._typeResolver = finalTypeResolver;
          }
        };

        Object.assign(allTypeClasses, {
          [element.name]: aliasClass
        });
      } else {
        throw new Error(`can not resolve type alias ${element.name} ${element.type}`);
      }
    }
  });

  Object.assign(allTypeClasses, structClasses);
  Object.assign(allTypeClasses, BasicScryptType);

  return allTypeClasses;
}



export function buildTypeResolver(contract: string, alias: AliasEntity[], structs: StructEntity[], staticConst: Record<string, number>): TypeResolver {
  const resolvedTypes: Record<string, string> = {};
  alias.forEach(element => {
    const type = resolveType(alias, element.name);
    const finalType = resolveStaticConst(contract, type, staticConst);
    resolvedTypes[element.name] = finalType;
  });
  structs.forEach(element => {
    resolvedTypes[element.name] = `struct ${element.name} {}`;
  });

  const resolver = (type: string) => {

    if (BasicScryptType[type]) {
      return `${type}`;
    }

    if (resolvedTypes[type]) {
      return `${resolvedTypes[type]}`;
    }


    if (isArrayType(type)) {
      const finalType = resolveStaticConst(contract, type, staticConst);

      const [elemTypeName, sizes] = arrayTypeAndSize(finalType);

      if (BasicScryptType[elemTypeName]) {
        return toLiteralArrayType(elemTypeName, sizes);
      } else if (resolvedTypes[elemTypeName]) {

        if (isArrayType(resolvedTypes[elemTypeName])) {
          const [elemTypeName_, sizes_] = arrayTypeAndSize(resolvedTypes[elemTypeName]);
          return toLiteralArrayType(elemTypeName_, sizes.concat(sizes_));
        }
        return toLiteralArrayType(resolvedTypes[elemTypeName], sizes);
      } else if (isStructType(elemTypeName)) {
        const structName = getStructNameByType(elemTypeName);
        return resolver(toLiteralArrayType(structName, sizes));
      } else {
        throw new Error('typeResolver with unknown elemTypeName ' + elemTypeName);
      }

    } else if (isStructType(type)) {
      const structName = getStructNameByType(type);
      return resolver(structName);
    } else {
      throw new Error('typeResolver with unknown type ' + type);
    }
  };

  return resolver;
}
