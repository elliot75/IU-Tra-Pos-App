import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes,createHash } from 'node:crypto';
import { writeArchive,stageArchive } from '../scripts/backup-pos.js';
import { validateConfiguration } from '../scripts/configure-pos.js';

test('資料庫與圖片加密封裝、驗證還原至新目錄，拒絕錯誤金鑰及竄改',async t=>{
  const root=await mkdtemp(join(tmpdir(),'iutra-backup-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dump=join(root,'dump'),manifest=join(root,'manifest'),image=join(root,'image');
  const imageData=Buffer.from('synthetic image bytes'),hash=createHash('sha256').update(imageData).digest('hex');
  await writeFile(dump,Buffer.alloc(180000,42));await writeFile(manifest,'{"test":true}');await writeFile(image,imageData);
  const records=[{path:'database.dump',file:dump},{path:'manifest.json',file:manifest},{path:`catalog-images/${hash}.png`,file:image}],key=randomBytes(32),file=join(root,'backup.iutrabak');
  await writeArchive(file,records,key);assert.equal((await stat(file)).mode&0o777,0o600);
  const destination=join(root,'stage');const result=await stageArchive(file,destination,key);assert.equal(result.files.length,3);
  assert.deepEqual(await readFile(join(destination,'database.dump')),await readFile(dump));
  assert.deepEqual(await readFile(join(destination,`catalog-images/${hash}.png`)),imageData);
  await assert.rejects(stageArchive(file,destination,key),{code:'EEXIST'});
  const wrong=join(root,'wrong');await assert.rejects(stageArchive(file,wrong,randomBytes(32)));await assert.rejects(stat(wrong),{code:'ENOENT'});
  const corrupt=await readFile(file);corrupt[40]^=1;await writeFile(join(root,'corrupt'),corrupt);
  await assert.rejects(stageArchive(join(root,'corrupt'),join(root,'corrupt-stage'),key));
  const traversal=join(root,'unsafe.iutrabak');await assert.rejects(writeArchive(traversal,[...records,{path:'../escape',file:image}],key));await assert.rejects(stat(traversal),{code:'ENOENT'});
});
test('維運設定不猜會員或退款政策，不接受未知權限或範例設備秘密',async()=>{
  const config=JSON.parse(await readFile(new URL('../config/pos.example.json',import.meta.url),'utf8'));
  assert.throws(()=>validateConfiguration(config),/隨機秘密/);
  config.device.key=randomBytes(32).toString('base64url');assert.equal(validateConfiguration(config),config);
  config.grants[0].permissions.push('admin');assert.throws(()=>validateConfiguration(config),/未知/);config.grants[0].permissions.pop();
  config.store.policy.walletEnabled=true;assert.throws(()=>validateConfiguration(config),/PIN/);
});
