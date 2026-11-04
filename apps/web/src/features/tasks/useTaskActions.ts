import { api } from '@/lib/api';
import { useApiMutation } from '@/lib/query';

const PATH = '/tasks';

/** State changes shared by the list and the board. Invalidating /tasks also refreshes the calendar. */
export function useTaskActions() {
  const start = useApiMutation<string>({
    mutationFn: (id) => api.post(`${PATH}/${id}/start`),
    invalidate: [PATH],
  });
  const cancel = useApiMutation<string>({
    mutationFn: (id) => api.post(`${PATH}/${id}/cancel`),
    invalidate: [PATH],
    successMessage: 'tasks:toast.cancelled',
  });
  const reopen = useApiMutation<string>({
    mutationFn: (id) => api.post(`${PATH}/${id}/reopen`),
    invalidate: [PATH],
    successMessage: 'tasks:toast.reopened',
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${PATH}/${id}`),
    invalidate: [PATH],
    successMessage: 'common:toast.deleted',
  });
  return { start, cancel, reopen, remove };
}
