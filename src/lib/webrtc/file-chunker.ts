/** PairDrop-style async chunk reader: 64 KB chunks, 1 MB partitions. */
const CHUNK_SIZE = 64 * 1024;
const MAX_PARTITION_SIZE = 1 * 1024 * 1024;

export class FileChunker {
  private readonly _file: File;
  private readonly _onChunk: (chunk: ArrayBuffer) => void;
  private readonly _onPartitionEnd: (offset: number) => void;
  private readonly _reader: FileReader;
  private _offset: number;
  private _partitionSize = 0;

  constructor(
    file: File,
    startOffset: number,
    onChunk: (chunk: ArrayBuffer) => void,
    onPartitionEnd: (offset: number) => void,
    private readonly _onFileEnd?: () => void
  ) {
    this._file = file;
    this._offset = startOffset;
    this._onChunk = onChunk;
    this._onPartitionEnd = onPartitionEnd;
    this._reader = new FileReader();
    this._reader.addEventListener("load", (event) => {
      const result = (event.target as FileReader).result;
      if (!(result instanceof ArrayBuffer)) return;
      this._onChunkRead(result);
    });
  }

  nextPartition(): void {
    this._partitionSize = 0;
    this._readChunk();
  }

  /** Rewind to the start of the last partition and resend (after reconnect). */
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

  private _onChunkRead(chunk: ArrayBuffer): void {
    this._offset += chunk.byteLength;
    this._partitionSize += chunk.byteLength;
    this._onChunk(chunk);

    if (this.isFileEnd()) {
      this._onFileEnd?.();
      return;
    }

    if (this._partitionSize >= MAX_PARTITION_SIZE) {
      this._onPartitionEnd(this._offset);
      return;
    }

    this._readChunk();
  }
}
