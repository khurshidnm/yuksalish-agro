import { Eye, EyeOff } from 'lucide-react';
import { type ComponentProps, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { controlClasses } from './input';

export function PasswordInput({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const label = visible ? t('auth:login.hidePassword') : t('auth:login.showPassword');
  return (
    <div className="relative">
      <input type={visible ? 'text' : 'password'} className={cn(controlClasses, 'pr-12', className)} {...props} />
      <button
        type="button"
        aria-label={label}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
        className="focus-ring absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-muted-foreground hover:text-foreground"
      >
        {visible ? <EyeOff className="size-5" aria-hidden /> : <Eye className="size-5" aria-hidden />}
      </button>
    </div>
  );
}
