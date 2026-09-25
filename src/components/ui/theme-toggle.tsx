import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Moon, Sun } from './icon'
import { Button } from './button'
import { applyTheme, getCurrentTheme, type Theme } from '@/lib/theme'

export function ThemeToggle() {
  const { t } = useTranslation()
  const [theme, setTheme] = useState<Theme>(getCurrentTheme)

  function toggle() {
    const next = theme === 'light' ? 'dark' : 'light'
    applyTheme(next)
    setTheme(next)
  }

  const label = theme === 'light' ? t('app.darkTheme') : t('app.lightTheme')
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={toggle}
      aria-label={label}
      title={label}
    >
      {theme === 'light' ? <Moon aria-hidden /> : <Sun aria-hidden />}
    </Button>
  )
}
