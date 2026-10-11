const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const target = new URL(url);
  if (target.origin !== 'https://api.reppyai.com') throw new Error('Unexpected API origin');
  return realFetch(new URL(target.pathname + target.search, process.env.REPPY_TEST_API_ORIGIN), options);
};
