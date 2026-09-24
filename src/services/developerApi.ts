import { call } from './ipc'

let reseedToken: string | null = null

export const developerApi = {
  clear: () => call<string>('clear_database'),
  loadDemo: (token?: string | null) =>
    call<void>('load_demo_data', token ? { reseedToken: token } : undefined),
  setReseedToken(token: string | null) {
    reseedToken = token
  },
  takeReseedToken() {
    return reseedToken
  },
}
