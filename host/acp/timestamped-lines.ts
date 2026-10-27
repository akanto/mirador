import { Transform } from "node:stream";

const NEWLINE = 0x0a;

/** Starts each line with the time its first output arrived, so an agent's log can be matched up with the host log. */
export const timestampedLines = (now = () => new Date()) => {
  let atLineStart = true;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      const pieces: Buffer[] = [];
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(NEWLINE, start);
        const end = newline === -1 ? chunk.length : newline + 1;
        if (atLineStart) pieces.push(Buffer.from(`${now().toISOString()} `));
        pieces.push(chunk.subarray(start, end));
        atLineStart = newline !== -1;
        start = end;
      }
      done(null, Buffer.concat(pieces));
    },
  });
};
