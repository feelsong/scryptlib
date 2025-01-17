import glob = require('glob');
import { basename, join } from 'path';
import { compileContract } from '../../src';
import { exit } from 'process';
import { copyFileSync, existsSync, mkdirSync } from 'fs';

function compileAllContracts() {

  const out = join(__dirname, "..", "..", "out");
  if (!existsSync(out)) {
    mkdirSync(out);
  }
  const contracts = glob.sync(join(__dirname, './*.scrypt'));
  contracts.forEach(filePath => {

    const result = compileContract(filePath, {
      out: out
    });

    if (result.errors.length > 0) {
      console.log(`Contract ${filePath} compiling failed with errors:`);
      console.log(result.errors);
      exit(1);
    }
  })
}


function copyDescFiles() {
  const descs = glob.sync(join(__dirname, 'desc', './*.json'));
  descs.forEach(filePath => {
    copyFileSync(filePath, join(__dirname, '..', '..', 'out', basename(filePath)))
  })
}


compileAllContracts();

copyDescFiles();