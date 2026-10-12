// Local operator boundary: no HTTP endpoint exposes these capabilities.
import { resolve } from 'node:path';
import { Store } from './store.ts';
const store = new Store(
  resolve(process.env.DATA_DIR ?? '.data', 'workspaces.sqlite'),
);
try {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 8192) throw new Error('Operator input is too large.');
  }
  const data = JSON.parse(text);
  if (process.argv[2] === 'bootstrap') {
    const user = await store.setup(data);
    console.log(
      JSON.stringify(
        await store.recoverAdministrator({
          ...data,
          email: user.email,
          reason: 'Initial administrator setup',
        }),
      ),
    );
  } else if (process.argv[2] === 'recover-admin')
    console.log(JSON.stringify(await store.recoverAdministrator(data)));
  else
    throw new Error(
      'Use bootstrap or recover-admin, with a JSON object on standard input.',
    );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Operator action failed.',
  );
  process.exitCode = 1;
} finally {
  store.close();
}
