import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { RouterProvider, useRouter } from './router'

function RouteProbe() {
  const { view, params, navigate } = useRouter()
  return (
    <>
      <output data-testid="view">{view}</output>
      <output data-testid="params">{JSON.stringify(params)}</output>
      <button onClick={() => navigate('reports')}>reports</button>
    </>
  )
}

describe('RouterProvider URL persistence', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('restores the current view from the browser URL on mount', () => {
    window.history.replaceState(null, '', '/reports')
    render(
      <RouterProvider>
        <RouteProbe />
      </RouterProvider>,
    )

    expect(screen.getByTestId('view')).toHaveTextContent('reports')
  })

  it('preserves dynamic route segments and follows browser history', () => {
    window.history.replaceState(null, '', '/inventory/123')
    render(
      <RouterProvider>
        <RouteProbe />
      </RouterProvider>,
    )

    expect(screen.getByTestId('view')).toHaveTextContent('inventory')
    expect(screen.getByTestId('params')).toHaveTextContent('["123"]')

    act(() => {
      window.history.pushState(null, '', '/inventory')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.getByTestId('view')).toHaveTextContent('inventory')
  })

  it('normalizes the legacy root URL to the canonical POS route', () => {
    window.history.replaceState(null, '', '/')
    render(
      <RouterProvider>
        <RouteProbe />
      </RouterProvider>,
    )

    expect(window.location.pathname).toBe('/pos')
    expect(screen.getByTestId('view')).toHaveTextContent('pos')
  })

  it('treats unknown routes as POS fallbacks without a dedicated view', () => {
    window.history.replaceState(null, '', '/dashboard/123')
    const { unmount } = render(
      <RouterProvider>
        <RouteProbe />
      </RouterProvider>,
    )

    expect(screen.getByTestId('view')).toHaveTextContent('pos')
    expect(screen.getByTestId('params')).toHaveTextContent('["123"]')
    unmount()

    window.history.replaceState(null, '', '/settings')
    render(
      <RouterProvider>
        <RouteProbe />
      </RouterProvider>,
    )

    expect(screen.getByTestId('view')).toHaveTextContent('pos')
  })

  it('routes the customers workspace to its own view', () => {
    window.history.replaceState(null, '', '/customers')
    render(
      <RouterProvider>
        <RouteProbe />
      </RouterProvider>,
    )

    expect(screen.getByTestId('view')).toHaveTextContent('customers')
    expect(screen.getByTestId('params')).toHaveTextContent('{}')
  })

  it('updates the URL when navigating through the existing router API', async () => {
    render(
      <RouterProvider>
        <RouteProbe />
      </RouterProvider>,
    )

    screen.getByRole('button', { name: 'reports' }).click()
    await waitFor(() => expect(window.location.pathname).toBe('/reports'))
    expect(screen.getByTestId('view')).toHaveTextContent('reports')
  })
})
