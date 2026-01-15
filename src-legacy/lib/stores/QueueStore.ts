import { Queue } from '@vegapunk/struct';

export class QueueStore<T extends object> extends Queue<T> {
  public state: 1 | 2 | 3 = 1;
  public isWorking: boolean = false;
  public isSleeping: boolean = false;

  public override dequeue(): T | undefined {
    this.isWorking = false;
    return super.dequeue();
  }
}
