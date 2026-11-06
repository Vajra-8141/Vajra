/**
 * The one place that decides which engine the screens get. `__FAKE__` is an esbuild define, so the branch not taken is dropped before
 * bundling: a production build never sees the fake, and a build without src/engine.ts fails in build.mjs.
 * `require` here is resolved by esbuild, and keeps `tsc` working while engine.ts is still being written.
 */
import type { Engine } from "./engine-types";

declare const __FAKE__: boolean;
declare function require(path: string): { engine: Engine };

export const isFake: boolean = __FAKE__;
export const engine: Engine = __FAKE__ ? require("./dev/fake-engine").engine : require("./engine").engine;
