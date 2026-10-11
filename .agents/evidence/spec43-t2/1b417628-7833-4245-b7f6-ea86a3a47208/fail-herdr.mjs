#!/Users/rolex/.local/share/fnm/node-versions/v24.19.0/installation/bin/node
import {appendFileSync} from 'node:fs'; appendFileSync("/Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-t2/.agents/evidence/spec43-t2/1b417628-7833-4245-b7f6-ea86a3a47208/failed-worker.jsonl", JSON.stringify({at:Date.now(),workerPid:process.ppid,args:process.argv.slice(2)})+'\n'); process.exit(1);
