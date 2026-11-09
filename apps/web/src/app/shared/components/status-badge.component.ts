import { Component, computed, input } from '@angular/core';
import type { JobStatus } from '@queuelab/shared-types';

const LABELS: Record<JobStatus, string> = {
  PENDING_ENQUEUE: 'Pending',
  QUEUED: 'Queued',
  PROCESSING: 'Processing',
  RETRYING: 'Retrying',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

@Component({
  selector: 'app-status',
  template: `<span class="status" [attr.data-status]="status()"><i></i>{{ label() }}</span>`,
})
export class StatusBadgeComponent {
  readonly status = input.required<JobStatus>();
  readonly label = computed(() => LABELS[this.status()]);
}
