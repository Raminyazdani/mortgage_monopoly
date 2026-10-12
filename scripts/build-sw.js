import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
async function filesAt(path='dist') {
  const entries=await readdir(path,{withFileTypes:true});
  return (await Promise.all(entries.map(e=>e.isDirectory()?filesAt(`${path}/${e.name}`):`${path}/${e.name}`))).flat();
}
const files=(await filesAt()).filter(f=>!f.endsWith('/sw.js'));
const paths=files.map(f=>`/${f.slice(5)}`).concat('/');
const hash=createHash('sha256');
for(const path of files) hash.update(await readFile(path));
const version=hash.digest('hex').slice(0,16);
const source=`const CACHE='mortgage-shell-${version}';
const ASSETS=${JSON.stringify(paths)};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('mortgage-shell-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.open(CACHE).then(cache=>cache.match('/index.html'))));return;}
event.respondWith(caches.open(CACHE).then(async cache=>await cache.match(event.request,{ignoreVary:true})||fetch(event.request)));});
`;
await writeFile('dist/sw.js',source);
console.log('Offline shell generated:',version);
