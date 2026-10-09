import { expect, it } from 'vitest';
import { closeWarning, disposeInOrder } from '../src/main/lifecycle';

it('warns about running replies even without terminals and names both kinds when present', () => {
  expect(closeWarning(0, 0)).toBeNull();
  expect(closeWarning(0, 1)?.message).toBe('1 reply is still running.');
  expect(closeWarning(0, 2)?.message).toBe('2 replies are still running.');
  expect(closeWarning(1, 0)?.message).toBe('1 terminal session is still running.');
  expect(closeWarning(2, 1)?.message).toBe('2 terminal sessions and 1 reply are still running.');
  expect(closeWarning(2, 1)?.detail).toContain('processes and replies');
});

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
