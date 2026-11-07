type TextProjection = { mode: 'offsets' | 'snapshot'; snapshot: 'rolling' | 'joined-segments' };
type TextSink = (text: string, offset?: number) => void;
const TEXT_LIMIT = 256_000;

/** Turn-local presentation state; native transports still own execution and completion. */
export class NativeTurnText {
  private completed = '';
  private completedLength = 0;
  private partial = '';
  private partialCount = 0;
  private rolling = '';

  constructor(private readonly projection: TextProjection, private readonly emit: TextSink) {}

  get text(): string { return this.completed; }
  get partialText(): string { return this.partial; }
  get partialLength(): number { return this.partialCount; }

  append(delta: string): void {
    const separator = this.completedLength ? '\n\n' : '';
    if (this.projection.mode === 'offsets') {
      this.emit((this.partialCount ? '' : separator) + delta, this.completedLength + (this.partialCount ? separator.length + this.partialCount : 0));
    }
    this.partialCount += delta.length;
    this.partial = (this.partial + delta).slice(-TEXT_LIMIT);
    if (this.projection.mode === 'snapshot' && this.projection.snapshot === 'rolling') {
      this.rolling = (this.rolling + delta).slice(-TEXT_LIMIT);
    }
    if (this.projection.mode === 'snapshot') this.publish();
  }

  complete(segment: string): void {
    const replacement = (this.completedLength ? '\n\n' : '') + segment;
    if (this.projection.mode === 'offsets') this.emit(replacement, this.completedLength);
    this.completedLength += replacement.length;
    this.partialCount = 0;
    this.partial = '';
    this.completed = (this.completed + (this.completed ? '\n\n' : '') + segment).slice(-TEXT_LIMIT);
    if (this.projection.mode === 'snapshot' && this.projection.snapshot === 'rolling') {
      this.rolling = `${this.completed}\n\n`;
    }
    if (this.projection.mode === 'snapshot') this.emit(this.completed);
  }

  /** Retracts a protocol-identified partial suffix without discarding genuine output. */
  retractPartial(length: number): void {
    this.partial = this.partial.slice(0, -length);
    this.partialCount -= length;
    if (this.projection.mode === 'offsets') this.emit('', this.completedLength + this.partialCount + (this.completedLength && this.partialCount ? 2 : 0));
    else this.publish();
  }

  startSegment(): void { this.partial = ''; this.partialCount = 0; }

  reset(): void {
    this.completed = ''; this.completedLength = 0;
    this.partial = ''; this.partialCount = 0; this.rolling = '';
  }

  private publish(): void {
    this.emit(this.projection.snapshot === 'rolling' ? this.rolling : [this.completed, this.partial].filter(Boolean).join('\n\n'));
  }
}
