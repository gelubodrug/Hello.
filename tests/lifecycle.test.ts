import { expect, it } from 'vitest';
import { disposeInOrder } from '../src/main/lifecycle';

it('releases every resource in order after synchronous and asynchronous failures',async()=>{
  const calls:string[]=[];
  const failures=await disposeInOrder([
    {name:'IPC',dispose(){calls.push('IPC');}},
    {name:'chat',async dispose(){calls.push('chat');throw new Error('private provider credential');}},
    {name:'terminal',dispose(){calls.push('terminal');throw new Error('another private error');}},
    {name:'browser',dispose(){calls.push('browser');}},
    {name:'database',dispose(){calls.push('database');}},
  ]);
  expect(calls).toEqual(['IPC','chat','terminal','browser','database']);
  expect(failures).toEqual(['chat','terminal']);
  expect(JSON.stringify(failures)).not.toContain('private');
});
