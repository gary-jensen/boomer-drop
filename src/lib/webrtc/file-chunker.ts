/** Async chunk reader: 256 KB chunks, 8 MB partitions. */
export const CHUNK_SIZE = 256 * 1024;
export const MAX_PARTITION_SIZE = 8 * 1024 * 1024;

export type ChunkHandler = (chunk: ArrayBuffer) => void | Promise<void>;

export class FileChunker {
  private readonly _file: File;
  private readonly _onChunk: ChunkHandler;
  private readonly _onPartitionEnd: (offset: number) => void;
  private readonly _onFileEnd?: () => void;
  private readonly _onError?: (error: Error) => void;
  private readonly _reader: FileReader;
  private _offset: number;
  private _partitionSize = 0;

  constructor(
    file: File,
    startOffset: number,
    onChunk: ChunkHandler,
    onPartitionEnd: (offset: number) => void,
    onFileEnd?: () => void,
    onError?: (error: Error) => void
  ) {
    this._file = file;
    this._offset = startOffset;
    this._onChunk = onChunk;
    this._onPartitionEnd = onPartitionEnd;
    this._onFileEnd = onFileEnd;
    this._onError = onError;
    this._reader = new FileReader();
    this._reader.addEventListener("load", (event) => {
      const result = (event.target as FileReader).result;
      if (!(result instanceof ArrayBuffer)) return;
      void this._onChunkRead(result);
    });
    this._reader.addEventListener("error", () => {
      this._onError?.(new Error("Failed to read file"));
    });
  }

  nextPartition(): void {
    this._partitionSize = 0;
    this._readChunk();
  }

  repeatPartition(): void {
    this._offset -= this._partitionSize;
    this.nextPartition();
  }

  isFileEnd(): boolean {
    return this._offset >= this._file.size;
  }

  get offset(): number {
    return this._offset;
  }

  private _readChunk(): void {
    if (this.isFileEnd()) return;
    const slice = this._file.slice(
      this._offset,
      this._offset + CHUNK_SIZE
    );
    this._reader.readAsArrayBuffer(slice);
  }

  private async _onChunkRead(chunk: ArrayBuffer): Promise<void> {
    try {
      this._offset += chunk.byteLength;
      this._partitionSize += chunk.byteLength;
      await this._onChunk(chunk);

      if (this.isFileEnd()) {
        this._onFileEnd?.();
        return;
      }

      if (this._partitionSize >= MAX_PARTITION_SIZE) {
        this._onPartitionEnd(this._offset);
        return;
      }

      this._readChunk();
    } catch (error) {
      this._onError?.(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}
