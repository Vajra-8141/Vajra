// The registry's access key is read here so it never has to be typed twice. Arkiv's SDK says it is not a secret, because it ships
// with any app that talks to the chain, so restrict it to your origins at hub.arkiv.network.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url).pathname);
} catch {
  // No key: reads use Arkiv's public endpoint, which has a small shared budget.
}

/** @type {import("next").NextConfig} */
export default {
  transpilePackages: ["@vajra/core"],
  env: { NEXT_PUBLIC_ARKIV_KEY: process.env.ARKIV ?? "" },
};
