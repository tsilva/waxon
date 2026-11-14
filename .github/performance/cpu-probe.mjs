// CI-only in-process profiler. No debugging listener or application hooks.
import { Session } from 'node:inspector';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

if (process.argv[1] === process.env.WAXON_PROFILE_TARGET) {
  const control = process.env.WAXON_PROFILE_CONTROL;
  const output = process.env.WAXON_PROFILE_OUTPUT;
  const session = new Session();
  session.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) =>
    session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: 1000 });
  await post('Profiler.start');
  const phases = [];
  let state = 'startup', pending = false;
  const stop = async phase => {
    const { profile } = await post('Profiler.stop');
    const raw = Buffer.from(JSON.stringify(profile));
    phases.push({ phase, sha256: createHash('sha256').update(raw).digest('hex'),
      bytes: raw.length, gzipBase64: gzipSync(raw).toString('base64') });
  };
  const timer = setInterval(async () => {
    if (pending || !existsSync(control)) return;
    pending = true;
    try {
      const command = JSON.parse(readFileSync(control, 'utf8')).command;
      if (command === 'first' && state === 'startup') {
        await stop('startup');
        await post('Profiler.start');
        state = 'first';
        writeFileSync(output + '.ready', 'first\n');
      } else if (command === 'stop' && state === 'first') {
        await stop('first');
        const body = JSON.stringify({ phases });
        if (Buffer.byteLength(body) > 900000) throw Error('Compressed CPU evidence exceeds bound');
        writeFileSync(output + '.tmp', body + '\n');
        renameSync(output + '.tmp', output);
        clearInterval(timer);
        session.disconnect();
        state = 'done';
      }
    } catch (error) {
      clearInterval(timer);
      session.disconnect();
      writeFileSync(output + '.error', String(error));
    } finally {
      pending = false;
    }
  }, 10);
  timer.unref();
}
