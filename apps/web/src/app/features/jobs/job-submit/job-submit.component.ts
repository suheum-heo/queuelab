import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MAX_UPLOAD_BYTES } from '@queuelab/shared-types';
import { httpErrorMessage } from '../../../core/api/http-error';
import { JobApiService } from '../../../core/api/job-api.service';

@Component({
  selector: 'app-job-submit',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './job-submit.component.html',
})
export class JobSubmitComponent {
  private readonly api = inject(JobApiService);
  private readonly router = inject(Router);
  private readonly formBuilder = inject(FormBuilder);

  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly fileName = signal<string | null>(null);
  readonly fileError = signal<string | null>(null);
  private file: File | null = null;

  readonly form = this.formBuilder.nonNullable.group({
    delimiter: [',', Validators.required],
    hasHeader: [true],
    transientFailure: [false],
  });

  chooseFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.file = input.files?.[0] ?? null;
    this.fileName.set(this.file?.name ?? null);
    this.fileError.set(fileProblem(this.file));
  }

  submit(): void {
    const problem = fileProblem(this.file);
    this.fileError.set(problem);
    if (problem || this.form.invalid || this.saving() || !this.file) {
      this.form.markAllAsTouched();
      return;
    }

    const raw = this.form.getRawValue();
    const file = this.file;
    this.saving.set(true);
    this.error.set(null);
    this.api.upload(file).subscribe({
      next: (upload) => {
        this.api
          .create({
            type: 'CSV_ANALYSIS',
            fileId: upload.id,
            options: {
              delimiter: raw.delimiter,
              hasHeader: raw.hasHeader,
              ...(raw.transientFailure ? { demoFailure: 'transient' as const } : {}),
            },
          })
          .subscribe({
            next: (job) => {
              void this.router.navigate(['/jobs', job.id]);
            },
            error: (error: unknown) => {
              this.error.set(httpErrorMessage(error));
              this.saving.set(false);
            },
          });
      },
      error: (error: unknown) => {
        this.error.set(httpErrorMessage(error));
        this.saving.set(false);
      },
    });
  }
}

function fileProblem(file: File | null): string | null {
  if (!file) return 'Choose a CSV file';
  if (!file.name.toLowerCase().endsWith('.csv')) return 'Only .csv files are accepted';
  if (file.size === 0) return 'CSV file is empty';
  if (file.size > MAX_UPLOAD_BYTES) return 'CSV files must be 10 MB or smaller';
  return null;
}
