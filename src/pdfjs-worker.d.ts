declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: {
    readonly setup: (handler: unknown, port: unknown) => void;
    readonly initializeFromPort: (port: unknown) => void;
  };
}
