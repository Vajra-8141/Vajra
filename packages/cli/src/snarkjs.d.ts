declare module "snarkjs" {
  export interface Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
  }
  export const groth16: {
    fullProve(input: Record<string, unknown>, wasm: string, zkey: string): Promise<{ proof: Proof; publicSignals: string[] }>;
    verify(vkey: unknown, publicSignals: string[], proof: Proof): Promise<boolean>;
  };
}
declare module "circomlibjs" {
  export function buildPoseidon(): Promise<{ (inputs: bigint[]): unknown; F: { toObject(value: unknown): bigint } }>;
}
