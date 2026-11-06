import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const MAGIC=Buffer.from('IUTRABK1');
const imageName=/^[a-f0-9]{64}\.(jpg|png|webp|gif)$/;
const allowedPath=value=>value==='database.dump'||value==='manifest.json'||/^catalog-images\/[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(value);
const keyFromEnv=()=>{const key=Buffer.from(process.env.POS_BACKUP_KEY_BASE64||'','base64');if(key.length!==32)throw new Error('POS_BACKUP_KEY_BASE64 必須為另行保管的 32-byte AES 金鑰');return key;};
async function digest(path) {const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
async function run(command,args,options={}) {
  await new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:['ignore','ignore','ignore'],...options});child.once('error',()=>reject(new Error(`${command} 無法執行`)));child.once('exit',code=>code===0?resolve():reject(new Error(`${command} 未完成；未輸出連線憑證`)));});
}
// Streaming records avoid loading database dumps into memory. Header+content authenticated by AES-GCM.
export async function writeArchive(destination,records,key) {
  if(key.length!==32)throw new Error('Invalid AES key');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const output=await open(destination,'wx',0o600);
  try {
    await output.write(Buffer.concat([MAGIC,iv]));
    async function* contents(){
      const seen=new Set();
      for(const record of records){
        if(!allowedPath(record.path)||seen.has(record.path))throw new Error('非法或重複備份路徑');seen.add(record.path);
        const size=(await stat(record.file)).size,hash=await digest(record.file);
        if(record.path.startsWith('catalog-images/')&&!record.path.includes(hash))throw new Error('圖片內容與 SHA-256 檔名不符');
        const header=Buffer.from(JSON.stringify({path:record.path,size,sha256:hash})),length=Buffer.alloc(4);length.writeUInt32BE(header.length);yield length;yield header;
        const verify=createHash('sha256');let count=0;
        for await(const chunk of createReadStream(record.file)){verify.update(chunk);count+=chunk.length;yield chunk;}
        if(count!==size||verify.digest('hex')!==hash)throw new Error('備份期間檔案改變，請重做相容快照');
      }
      if(!seen.has('database.dump')||!seen.has('manifest.json'))throw new Error('缺少必要備份檔案');
      yield Buffer.alloc(4);
    }
    await pipeline(Readable.from(contents()),cipher,createWriteStream(destination,{fd:output.fd,start:20,autoClose:false}));
    await output.write(cipher.getAuthTag(),0,16,(await output.stat()).size);
    await output.sync();
  }catch(error){try { await output.close(); } catch {} await rm(destination,{force:true});throw error;}
  await output.close();
}
export async function stageArchive(source,destination,key) {
  const info=await stat(source);if(info.size<40)throw new Error('備份不完整');
  const input=await open(source,'r'),prefix=Buffer.alloc(20),tag=Buffer.alloc(16);
  await input.read(prefix,0,20,0);await input.read(tag,0,16,info.size-16);await input.close();
  if(!prefix.subarray(0,8).equals(MAGIC))throw new Error('不支援此備份版本');
  // Destination must be new. Never overwrite an existing directory or restore a database here.
  await mkdir(destination,{mode:0o700});const temporary=join(destination,'.authenticated-payload');
  try {
    const decipher=createDecipheriv('aes-256-gcm',key,prefix.subarray(8));decipher.setAuthTag(tag);
    await pipeline(createReadStream(source,{start:20,end:info.size-17}),decipher,createWriteStream(temporary,{flags:'wx',mode:0o600}));
    const handle=await open(temporary,'r');let offset=0;const names=new Set(),total=(await handle.stat()).size;
    const exact=async size=>{const buffer=Buffer.alloc(size);const result=await handle.read(buffer,0,size,offset);if(result.bytesRead!==size)throw new Error('備份截斷');offset+=size;return buffer;};
    try {
      while(offset<total){
        const length=(await exact(4)).readUInt32BE();if(length===0){if(offset!==total)throw new Error('備份尾端不正確');break;}
        if(length>4096)throw new Error('備份標頭過大');const header=JSON.parse((await exact(length)).toString('utf8'));
        if(!allowedPath(header.path)||names.has(header.path)||!Number.isSafeInteger(header.size)||header.size<0||header.size>total-offset||!/^[a-f0-9]{64}$/.test(header.sha256))throw new Error('備份路徑或大小不正確');
        names.add(header.path);const target=join(destination,header.path);
        if(header.path.startsWith('catalog-images/')){await mkdir(dirname(target),{recursive:true,mode:0o700});if(!header.path.includes(header.sha256))throw new Error('圖片雜湊檔名不符');}
        const hash=createHash('sha256'),output=await open(target,'wx',0o600);let left=header.size;
        try{while(left){const data=await exact(Math.min(left,65536));hash.update(data);await output.write(data);left-=data.length;}}finally{await output.close();}
        if(hash.digest('hex')!==header.sha256)throw new Error('備份內容雜湊不符');
      }
      if(!names.has('database.dump')||!names.has('manifest.json'))throw new Error('缺少必要還原檔');
    }finally{await handle.close();}
    await rm(temporary);
    return {directory:destination,files:[...names]};
  }catch(error){await rm(destination,{recursive:true,force:true});throw error;}
}
export async function backup(destination,{databaseURL,imagesDirectory,key}) {
  if(!databaseURL)throw new Error('尚未設定 DATABASE_URL');
  const temp=await mkdtemp(join(tmpdir(),'iutra-backup-'));
  try {
    const dump=join(temp,'database.dump');
    // Credentials stay in the child environment, never in command arguments or logs.
    await run('pg_dump',['--format=custom','--no-owner','--no-acl',`--file=${dump}`],{env:{...process.env,PGDATABASE:databaseURL}});
    const records=[{path:'database.dump',file:dump}],images=[];
    for(const name of (await readdir(imagesDirectory)).sort())if(imageName.test(name)){
      const file=join(imagesDirectory,name),hash=await digest(file);if(hash!==name.split('.')[0])throw new Error('商品圖片雜湊不符');
      records.push({path:`catalog-images/${name}`,file});images.push({path:`catalog-images/${name}`,sha256:hash});
    }
    const manifest=join(temp,'manifest.json');
    const handle=await open(manifest,'wx',0o600);await handle.writeFile(JSON.stringify({schemaVersion:1,createdAt:new Date().toISOString(),databaseSha256:await digest(dump),images},null,2));await handle.close();
    records.push({path:'manifest.json',file:manifest});await writeArchive(destination,records,key);
  }finally{await rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const [command,source,destination]=process.argv.slice(2),key=keyFromEnv();
    if(command==='backup'&&source&&!destination){await backup(resolve(source),{databaseURL:process.env.DATABASE_URL,imagesDirectory:resolve('public/catalog-images'),key});console.log('資料庫與圖片已加密備份；尚未執行還原演練。');}
    else if(command==='stage-restore'&&source&&destination){const result=await stageArchive(resolve(source),resolve(destination),key);console.log(`已驗證並解密 ${result.files.length} 檔到全新 staging 目錄，未連線、未覆寫任何資料庫。`);}
    else throw new Error('用法：backup-pos.js backup 新檔.iutrabak 或 stage-restore 備份.iutrabak 全新目錄');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
