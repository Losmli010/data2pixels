import type { SampleWindow } from './ring';

export interface ChannelView {
  id: string;
  label: string;
  color: string;
  samples: SampleWindow;
  visible: boolean;
}
