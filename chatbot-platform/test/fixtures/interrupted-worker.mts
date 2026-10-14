import {ConversationQueue} from '../../src/engine/queue.js';
const queue=new ConversationQueue(async()=>{
  process.send?.({state:'processing'});
  await new Promise(()=>{});
  return {status:'replied'};
});
await queue.runDue();
setInterval(()=>{},1000);
