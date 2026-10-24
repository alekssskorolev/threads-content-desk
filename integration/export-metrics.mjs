#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {collectorToMetrics} from './collector-adapter.mjs';
const args=process.argv.slice(2),index=args.indexOf('--out'),out=index<0?null:args[index+1],inputs=index<0?args:args.slice(0,index);
if(!inputs.length||!out){console.error('Usage: node integration/export-metrics.mjs archive1.json [archive2.json ...] --out threads-metrics.json');process.exit(1);}
try {
 const observations=[],warnings=[];
 for(const filename of inputs){const result=collectorToMetrics(JSON.parse(fs.readFileSync(filename,'utf8')));observations.push(...result.observations);warnings.push(...result.warnings);}
 const target=path.resolve(out);if(inputs.some(f=>path.resolve(f)===target))throw Error('Выходной файл не должен совпадать с исходным архивом');
 fs.mkdirSync(path.dirname(target),{recursive:true});const tmp=target+'.tmp';fs.writeFileSync(tmp,JSON.stringify({kind:'threads-metrics',version:1,observations,warnings},null,2),{mode:0o600});fs.renameSync(tmp,target);
 console.log(`Exported ${observations.length} root-post observations. Warnings: ${warnings.length}.`);
}catch(e){console.error(e.message);process.exit(1);}
