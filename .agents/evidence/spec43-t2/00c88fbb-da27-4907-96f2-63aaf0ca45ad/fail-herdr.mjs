#!/Users/rolex/.local/share/fnm/node-versions/v24.19.0/installation/bin/node
import {appendFileSync} from 'node:fs'; appendFileSync("/Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-t2/.agents/evidence/spec43-t2/00c88fbb-da27-4907-96f2-63aaf0ca45ad/failed-worker.jsonl", JSON.stringify({at:Date.now(),workerPid:process.ppid,args:process.argv.slice(2)})+'\n'); process.exit(1);
