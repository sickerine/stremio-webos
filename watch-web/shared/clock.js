// Clock sync: each ping yields { rtt, offset } where offset = localMs - remoteMs.
// Trust the one that travelled fastest; queueing only ever inflates the others.
export function bestOffset(samples) {
  let best = null;
  for (const s of samples) if (!best || s.rtt < best.rtt) best = s;
  return best ? best.offset : null;
}

