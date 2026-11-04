import { PRIORITIES, TASK_STATUSES, todayIso } from '@yap/shared';
import { Camera, CheckCircle2, ClipboardCheck, ListChecks, Pencil, Play, Plus, Repeat, RotateCcw, Trash2, XCircle } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable, PageHeader, UrlTabs, useConfirm, useUrlParam } from '@/components';
import { Badge, type BadgeVariant, Button, Combobox, Input, Label, Select, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { cn } from '@/lib/utils';
import { CompleteTaskDialog } from './CompleteTaskDialog';
import { TaskBoard } from './TaskBoard';
import { TaskFormDialog, memberOptions } from './TaskFormDialog';
import { DIVISIONS, entityText, isClosed, type Task } from './types';
import { useTaskActions } from './useTaskActions';

const STATUS_TONE: Record<Task['status'], BadgeVariant> = {
  open: 'neutral',
  in_progress: 'info',
  done: 'success',
  cancelled: 'outline',
};

const PRIORITY_TONE: Record<Task['priority'], BadgeVariant> = { low: 'outline', normal: 'neutral', high: 'warning' };

function QuickAdd() {
  const { t } = useTranslation('tasks');
  const [title, setTitle] = useState('');
  const add = useApiMutation<string>({
    mutationFn: (value) => api.post('/tasks', { title: value, dueDate: todayIso() }),
    invalidate: ['/tasks'],
    successMessage: 'common:toast.created',
    onSuccess: () => setTitle(''),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = title.trim();
    if (value) add.mutate(value);
  };
  return (
    <form onSubmit={submit} className="mb-4 flex gap-2">
      <Input
        aria-label={t('quickAdd.label')}
        placeholder={t('quickAdd.placeholder')}
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Button type="submit" variant="secondary" loading={add.isPending} disabled={!title.trim()}>
        {t('quickAdd.button')}
      </Button>
    </form>
  );
}

interface ListProps {
  onEdit: (task: Task) => void;
  onComplete: (task: Task) => void;
}

function TaskList({ onEdit, onComplete }: ListProps) {
  const { t } = useTranslation('tasks');
  const canDelete = usePermission('tasks.delete');
  const confirm = useConfirm();
  const { start, cancel, reopen, remove } = useTaskActions();

  const [status, setStatus] = useUrlParam('status');
  const [division, setDivision] = useUrlParam('division');
  const [priority, setPriority] = useUrlParam('priority');
  const [assignee, setAssignee] = useUrlParam('assignee');
  const [assigneeName, setAssigneeName] = useUrlParam('assigneeName');
  const [overdue, setOverdue] = useUrlParam('overdue');
  const [mine, setMine] = useUrlParam('mine');

  const columns: Column<Task>[] = [
    {
      key: 'title',
      header: t('fields.title'),
      sortable: true,
      mobile: 'title',
      cell: (task) => (
        <div className="min-w-0">
          <p className="font-medium break-words">{task.title}</p>
          {task.entityLink && task.entityLabel && (
            <Link to={task.entityLink} className="text-sm text-muted-foreground underline">
              {entityText(task, t)}
            </Link>
          )}
        </div>
      ),
    },
    { key: 'assignee', header: t('fields.assignee'), cell: (task) => task.assigneeName ?? '—', mobile: 'subtitle' },
    {
      key: 'dueDate',
      header: t('fields.dueDate'),
      sortable: true,
      cell: (task) => {
        const late = !isClosed(task) && task.dueDate !== null && task.dueDate < todayIso();
        return <span className={cn(late && 'font-medium text-danger')}>{formatDate(task.dueDate)}</span>;
      },
    },
    {
      key: 'priority',
      header: t('fields.priority'),
      sortable: true,
      cell: (task) => <Badge variant={PRIORITY_TONE[task.priority]}>{t(`enums:priority.${task.priority}`)}</Badge>,
    },
    {
      key: 'status',
      header: t('fields.status'),
      sortable: true,
      cell: (task) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <Badge variant={STATUS_TONE[task.status]}>{t(`enums:taskStatus.${task.status}`)}</Badge>
          {task.requiresPhoto && !isClosed(task) && <Camera className="size-4 text-muted-foreground" aria-label={t('needsPhoto')} />}
          {task.requiresRecord && !isClosed(task) && (
            <ClipboardCheck className="size-4 text-muted-foreground" aria-label={t(`record.${task.requiresRecord}`)} />
          )}
        </span>
      ),
    },
  ];

  return (
    <DataTable<Task>
      path="/tasks"
      params={{
        status: status || undefined,
        division: division || undefined,
        priority: priority || undefined,
        assigneeUserId: assignee || undefined,
        overdue: overdue === '1' ? true : undefined,
        mine: mine === '1' ? true : undefined,
      }}
      columns={columns}
      searchPlaceholder={t('searchPlaceholder')}
      filters={
        <>
          <Select
            aria-label={t('fields.status')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={enumOptions('taskStatus', TASK_STATUSES)}
            placeholder={t('filters.allStatuses')}
            className="md:w-44"
          />
          <Select
            aria-label={t('fields.division')}
            value={division}
            onChange={(e) => setDivision(e.target.value)}
            options={DIVISIONS.map((d) => ({ value: d, label: t(`division.${d}`) }))}
            placeholder={t('filters.allDivisions')}
            className="md:w-44"
          />
          <Select
            aria-label={t('fields.priority')}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            options={enumOptions('priority', PRIORITIES)}
            placeholder={t('filters.allPriorities')}
            className="md:w-40"
          />
          <Combobox
            value={assignee || null}
            onChange={(value, option) => {
              setAssignee(value ?? '');
              setAssigneeName(option?.label ?? '');
            }}
            loadOptions={memberOptions}
            selectedLabel={assigneeName || undefined}
            placeholder={t('filters.allPeople')}
            className="md:w-52"
          />
          <div className="flex min-h-11 items-center gap-4">
            <Label className="flex items-center gap-2 text-sm font-normal">
              <Switch checked={mine === '1'} onCheckedChange={(on) => setMine(on ? '1' : '')} />
              {t('filters.mine')}
            </Label>
            <Label className="flex items-center gap-2 text-sm font-normal">
              <Switch checked={overdue === '1'} onCheckedChange={(on) => setOverdue(on ? '1' : '')} />
              {t('filters.overdue')}
            </Label>
          </div>
        </>
      }
      empty={{ icon: ListChecks, title: t('emptyTitle'), description: t('emptyBody') }}
      rowActions={(task) => [
        { label: t('actions.complete'), icon: CheckCircle2, hidden: isClosed(task), onClick: () => onComplete(task) },
        { label: t('actions.start'), icon: Play, hidden: task.status !== 'open', onClick: () => start.mutate(task.id) },
        { label: t('common:actions.edit'), icon: Pencil, onClick: () => onEdit(task) },
        { label: t('actions.reopen'), icon: RotateCcw, hidden: !isClosed(task), onClick: () => reopen.mutate(task.id) },
        { label: t('actions.cancel'), icon: XCircle, hidden: isClosed(task), onClick: () => cancel.mutate(task.id) },
        {
          label: t('common:actions.delete'),
          icon: Trash2,
          destructive: true,
          hidden: !canDelete,
          onClick: async () => {
            const ok = await confirm({
              title: t('deleteTitle'),
              description: t('deleteBody', { name: task.title }),
              destructive: true,
            });
            if (ok) remove.mutate(task.id);
          },
        },
      ]}
    />
  );
}

function RecurringList({ onEdit }: Pick<ListProps, 'onEdit'>) {
  const { t } = useTranslation('tasks');
  const canDelete = usePermission('tasks.delete');
  const confirm = useConfirm();
  const { cancel, reopen, remove } = useTaskActions();

  const columns: Column<Task>[] = [
    { key: 'title', header: t('fields.title'), sortable: true, mobile: 'title', cell: (task) => task.title },
    {
      key: 'recurrence',
      header: t('fields.recurrence'),
      mobile: 'subtitle',
      cell: (task) => <Badge variant="info">{t(`enums:recurrence.${task.recurrence}`)}</Badge>,
    },
    { key: 'assignee', header: t('fields.assignee'), cell: (task) => task.assigneeName ?? '—' },
    { key: 'dueDate', header: t('fields.startDate'), sortable: true, cell: (task) => formatDate(task.dueDate) },
    {
      key: 'status',
      header: t('fields.status'),
      cell: (task) => (
        <Badge variant={task.status === 'open' ? 'success' : 'outline'}>{task.status === 'open' ? t('series.running') : t('series.stopped')}</Badge>
      ),
    },
  ];

  return (
    <>
      <p className="mb-3 text-sm text-muted-foreground">{t('series.explain')}</p>
      <DataTable<Task>
        path="/tasks"
        urlPrefix="series"
        params={{ recurring: true }}
        columns={columns}
        searchable={false}
        empty={{ icon: Repeat, title: t('series.emptyTitle'), description: t('series.emptyBody') }}
        rowActions={(task) => [
          { label: t('common:actions.edit'), icon: Pencil, onClick: () => onEdit(task) },
          { label: t('series.stop'), icon: XCircle, hidden: task.status !== 'open', onClick: () => cancel.mutate(task.id) },
          { label: t('series.resume'), icon: RotateCcw, hidden: task.status === 'open', onClick: () => reopen.mutate(task.id) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !canDelete,
            onClick: async () => {
              const ok = await confirm({
                title: t('deleteTitle'),
                description: t('deleteBody', { name: task.title }),
                destructive: true,
              });
              if (ok) remove.mutate(task.id);
            },
          },
        ]}
      />
    </>
  );
}

export default function TasksPage() {
  const { t } = useTranslation('tasks');
  const canManage = usePermission('tasks.create');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [completing, setCompleting] = useState<Task | null>(null);

  const dialogs = (
    <>
      <TaskFormDialog
        open={creating || editing !== null}
        task={editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
      />
      {/* Keyed so that the form's rules are rebuilt for each task. */}
      <CompleteTaskDialog
        key={completing?.id ?? 'none'}
        task={completing}
        onOpenChange={(open) => {
          if (!open) setCompleting(null);
        }}
      />
    </>
  );

  // Field staff get their own work and nothing else to think about.
  if (!canManage) {
    return (
      <>
        <PageHeader title={t('myTitle')} description={t('myDescription')} />
        <TaskBoard onComplete={setCompleting} onEdit={setEditing} />
        {dialogs}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('add')}
          </Button>
        }
      />
      <QuickAdd />
      <UrlTabs
        tabs={[
          { value: 'board', label: t('tabs.board'), content: <TaskBoard onComplete={setCompleting} onEdit={setEditing} /> },
          { value: 'list', label: t('tabs.list'), content: <TaskList onComplete={setCompleting} onEdit={setEditing} /> },
          { value: 'recurring', label: t('tabs.recurring'), content: <RecurringList onEdit={setEditing} /> },
        ]}
      />
      {dialogs}
    </>
  );
}
