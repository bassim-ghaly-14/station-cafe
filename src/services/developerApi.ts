import { call } from './ipc'

let reseedToken: string | null = null

export const developerApi = {
  clear: () => call<string>('clear_database'),
  loadOfficial: (token?: string | null) =>
    call<void>('load_official_data', token ? { reseedToken: token } : undefined),
  setReseedToken(token: string | null) {
    reseedToken = token
  },
  takeReseedToken() {
    return reseedToken
  },
  clearReseedToken() {
    reseedToken = null
  },
}
