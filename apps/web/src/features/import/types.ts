export interface TemplateColumn {
  key: string;
  required: boolean;
}

export interface TemplateInfo {
  key: string;
  link: string;
  allowed: boolean;
  columns: TemplateColumn[];
}

export interface ExportInfo {
  key: string;
  allowed: boolean;
}

export interface ImportCatalog {
  maxRows: number;
  templates: TemplateInfo[];
  exports: ExportInfo[];
}

export interface ProblemGroup {
  column: string | null;
  message: string;
  count: number;
  rows: number[];
}

export type RowStatus = 'new' | 'update' | 'skip' | 'error';
export type JobStatus = 'preview' | 'confirmed' | 'discarded';

export interface ImportJob {
  id: string;
  template: string;
  fileName: string;
  status: JobStatus;
  totalRows: number;
  importedRows: number;
  summary: Record<string, number | undefined>;
  createdAt: string;
  link: string;
  errors: ProblemGroup[];
  warnings: ProblemGroup[];
}

export interface RowMessage {
  column?: string;
  message: string;
}

export interface JobRow {
  row: number;
  status: RowStatus;
  values: Record<string, string | number | null>;
  errors: RowMessage[];
  warnings: RowMessage[];
  note?: string;
}

export interface JobListItem {
  id: string;
  template: string;
  fileName: string;
  status: JobStatus;
  totalRows: number;
  importedRows: number;
  createdAt: string;
  createdByName: string | null;
}
