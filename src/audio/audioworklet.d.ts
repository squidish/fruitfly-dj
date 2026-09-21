/**
 * Minimal AudioWorkletGlobalScope declarations. The DOM lib does not describe
 * the worklet scope, and pulling in a whole extra @types package for four
 * symbols is not worth it.
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  ctor: new (options?: { processorOptions?: unknown }) => AudioWorkletProcessor,
): void;

/** Context time at the start of the current render quantum. */
declare const currentTime: number;
declare const sampleRate: number;
