import { Component, input } from '@angular/core';
import type { JobStatus } from '@queuelab/shared-types';

@Component({
  selector: 'app-progress',
  template: `
    <div
      class="bar"
      role="progressbar"
      [attr.aria-valuenow]="value()"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <span [style.width.%]="value()" [attr.data-status]="status()"></span>
    </div>
  `,
})
export class ProgressBarComponent {
  readonly value = input(0);
  readonly status = input<JobStatus>('QUEUED');
}
