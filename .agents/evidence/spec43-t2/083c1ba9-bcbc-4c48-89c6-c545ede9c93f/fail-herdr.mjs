#!/Users/rolex/.local/share/fnm/node-versions/v24.19.0/installation/bin/node
import {appendFileSync} from 'node:fs'; appendFileSync("/Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-t2/.agents/evidence/spec43-t2/083c1ba9-bcbc-4c48-89c6-c545ede9c93f/failed-worker.jsonl", JSON.stringify({at:Date.now(),workerPid:process.ppid,args:process.argv.slice(2)})+'\n'); process.exit(1);
