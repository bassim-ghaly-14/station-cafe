/**
 * Station Cafe — LOCAL WEB: the user interface.
 *
 * Plain DOM, no framework, no bundler — the file is served verbatim to a phone
 * browser, so every line here has to run as-is on iOS Safari and Android
 * Chrome with no build step and no internet.
 *
 * States, and the transitions between them:
 *
 *   loading ──(locale + session checked)──▶ login
 *                                            │ POST /auth/login 200
 *                                            ▼
 *   login ◀──(401, or logout, or revoked)── dashboard ──▶ error (offline)
 *
 * Authorization is NEVER decided here. The UI renders whatever the Rust server
 * returned; a 403 from /manager/summary is shown as "managers only" rather than
 * being hidden, and a 401 always returns the user to the login screen. What the
 * user can see is decided by `auth::require_role` in Rust, not by this file.
 */

import { StationApi, isForbidden, isUnauthorized } from './api.js'
import { LOCAL_STRINGS, loadStrings } from './strings.js'

/**
 * Build an element. Text is always set through `textContent`, never
 * `innerHTML`, so a name or a message from the server can never inject markup.
 *
 * @param {string} tag
 * @param {{ class?: string, text?: string, attrs?: Record<string, string> }} [props]
 * @param {Array<Node | string>} [children]
 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  if (props.class) node.className = props.class
  if (props.text !== undefined) node.textContent = props.text
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    node.setAttribute(name, value)
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

/**
 * The application.
 *
 * Everything is injected so the whole surface can be driven in a test with a
 * fake API and a fake DOM, with no network and no real browser.
 */
export class LocalWebApp {
  /**
   * @param {{
   *   root: HTMLElement,
   *   api?: StationApi,
   *   strings?: Strings,
   *   fetchImpl?: typeof fetch,
   * }} options
   */
  constructor(options) {
    this.root = options.root
    this.api = options.api ?? new StationApi({ fetchImpl: options.fetchImpl })
    this.strings = options.strings ?? null
    /** @type {'loading' | 'login' | 'dashboard' | 'error'} */
    this.state = 'loading'
    /** @type {{ id: number, name: string, role: string } | null} */
    this.user = null
    /** @type {{ open_day: boolean } | null} */
    this.summary = null
    /** @type {string | null} */
    this.error = null
    /** @type {boolean} */
    this.busy = false
    /** @type {boolean} */
    this.managerDataAllowed = false
    /**
     * Whether the last summary attempt was refused by the server's
     * authorization (403) rather than failing for any other reason. Tracked
     * explicitly so the dashboard can explain itself accurately.
     * @type {boolean}
     */
    this.summaryForbidden = false
  }

  /**
   * Translate a dotted key.
   *
   * The shared desktop locale is consulted FIRST, so this surface reuses the
   * product's real wording wherever one exists. Keys that exist only here (the
   * `local.*` block) are then resolved against [`LOCAL_STRINGS`], which is
   * already keyed by its full dotted name.
   *
   * A key missing from both yields a neutral placeholder rather than
   * `undefined`, so a gap degrades to readable text instead of a blank screen.
   * Production never hits that: the shared keys are asserted against the real
   * locale file in a test.
   *
   * @param {string} key
   * @param {Record<string, string | number>} [values]
   */
  t(key, values) {
    const template = this.strings?.flat[key] ?? LOCAL_STRINGS[key] ?? `?? ${key}`
    if (!values) return template
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) =>
      name in values ? String(values[name]) : match,
    )
  }

  /**
   * Boot: load the shared locale, then decide between the login screen and the
   * dashboard from the session alone.
   */
  async start() {
    try {
      if (!this.strings) this.strings = await loadStrings({ fetchImpl: this.api.fetchImpl })
    } catch {
      // Without strings there is no Arabic UI to show. The failure is reported
      // rather than swallowed: a blank screen on a manager's phone is worse.
      this.state = 'error'
      this.error = 'strings'
      this.render()
      return
    }

    this.renderLoading()
    // A stored token is only a CLAIM. The server decides whether it is still
    // valid, so /me is always called; a 401 here is the normal expiry path.
    if (this.api.session.isAuthenticated) {
      try {
        this.user = await this.api.me()
        this.state = 'dashboard'
      } catch (error) {
        this.api.logout()
        if (isUnauthorized(error)) {
          this.error = this.t('errors.auth.session_expired')
        } else {
          this.error = this.t('errors.internal_error')
        }
        this.state = 'login'
      }
    } else {
      this.state = 'login'
    }
    this.render()
    if (this.state === 'dashboard') void this.loadSummary()
  }

  // ---- Actions ------------------------------------------------------------

  /**
   * Authenticate. The password is read from the field and handed straight to
   * the API; it is never stored, never logged and never put in the URL.
   *
   * @param {string} name
   * @param {string} password
   */
  async submitLogin(name, password) {
    const trimmed = name.trim()
    if (!trimmed || !password) {
      // A missing field is reported inline, in Arabic, without a network call.
      this.error = trimmed ? this.t('auth.passwordRequired') : this.t('auth.nameRequired')
      this.state = 'login'
      this.render()
      return false
    }

    this.busy = true
    this.error = null
    this.render()
    try {
      this.user = await this.api.login(trimmed, password)
      this.state = 'dashboard'
      this.summary = null
      this.managerDataAllowed = false
      this.summaryForbidden = false
      this.render()
      void this.loadSummary()
      return true
    } catch (error) {
      // A wrong password and a throttled attempt both land here; neither is
      // distinguished in the message, so the form cannot be used to probe which
      // usernames exist.
      this.busy = false
      this.error =
        error?.status === 429
          ? this.t('errors.internal_error')
          : this.t('errors.auth.bad_credentials')
      this.state = 'login'
      this.render()
      return false
    }
  }

  /**
   * Load today's manager summary.
   *
   * A 403 is a legitimate, expected answer for a STAFF session and is rendered
   * as a notice — the dashboard still shows who is signed in, without any
   * financial figure. A 401 means the session died mid-flight and returns the
   * user to the login screen.
   */
  async loadSummary() {
    try {
      this.summary = await this.api.managerSummary()
      this.managerDataAllowed = true
    } catch (error) {
      this.summary = null
      this.managerDataAllowed = false
      // Whether the refusal was specifically an authorization one decides the
      // notice shown. A 403 is a legitimate answer for a STAFF session; any
      // other failure is a connection problem. Neither is ever turned into a
      // fake empty summary — showing "no sales today" to someone who is not
      // allowed to see sales would be worse than showing nothing.
      this.summaryForbidden = isForbidden(error)
      if (isUnauthorized(error)) {
        this.api.logout()
        this.user = null
        this.summaryForbidden = false
        this.error = this.t('errors.auth.session_expired')
        this.state = 'login'
      }
    }
    this.render()
  }

  /** End the session and return to the login screen. */
  logout() {
    this.api.logout()
    this.user = null
    this.summary = null
    this.managerDataAllowed = false
    this.summaryForbidden = false
    this.error = null
    this.busy = false
    this.state = 'login'
    this.render()
  }

  // ---- Rendering ----------------------------------------------------------

  renderLoading() {
    this.state = 'loading'
    this.root.replaceChildren(
      el('p', { class: 'loading', text: this.t('local.connecting'), attrs: { role: 'status' } }),
    )
  }

  /** The Station wordmark, shared by every screen. */
  header() {
    return el('header', { class: 'header' }, [
      el('div', { class: 'header__mark', text: 'S', attrs: { 'aria-hidden': 'true' } }),
      el('div', { class: 'header__text' }, [
        el('h1', { class: 'header__title', text: this.t('app.name') }),
        el('p', { class: 'header__subtitle', text: this.t('local.subtitle') }),
      ]),
    ])
  }

  /** A label/value row. Long values wrap instead of widening the page. */
  row(label, value) {
    return el('div', { class: 'row' }, [
      el('span', { class: 'row__label', text: label }),
      el('span', { class: 'row__value', text: value }),
    ])
  }

  /**
   * The login form.
   *
   * `autocomplete` is set to the standard values so a phone can offer
   * credentials from its own store — the browser's password manager, not
   * Station's, decides what to keep.
   */
  renderLogin() {
    const nameInput = el('input', {
      class: 'input',
      attrs: {
        id: 'login-name',
        name: 'username',
        type: 'text',
        autocomplete: 'username',
        autocapitalize: 'none',
        autocorrect: 'off',
        spellcheck: 'false',
        // Arabic UI, but the credential itself is Latin: force LTR inside the
        // field so a mixed-script name is not reordered while typing.
        dir: 'ltr',
        enterkeyhint: 'next',
      },
    })
    nameInput.value = ''

    const passwordInput = el('input', {
      class: 'input',
      attrs: {
        id: 'login-password',
        name: 'password',
        type: 'password',
        autocomplete: 'current-password',
        dir: 'ltr',
        enterkeyhint: 'go',
      },
    })
    passwordInput.value = ''

    const submit = el('button', {
      class: 'button',
      text: this.busy ? this.t('auth.signingIn') : this.t('auth.signIn'),
      attrs: { type: 'submit', id: 'login-submit' },
    })
    if (this.busy) submit.disabled = true

    const form = el('form', { class: 'card card--centered', attrs: { novalidate: '' } }, [
      el('h2', { class: 'card__title', text: this.t('auth.signIn') }),
      el('div', { class: 'field' }, [
        el('label', {
          class: 'field__label',
          text: this.t('auth.name'),
          attrs: { for: 'login-name' },
        }),
        nameInput,
      ]),
      el('div', { class: 'field' }, [
        el('label', {
          class: 'field__label',
          text: this.t('auth.password'),
          attrs: { for: 'login-password' },
        }),
        passwordInput,
      ]),
      submit,
    ])

    // The error is INSIDE the form and announced, never an alert() dialog: a
    // native alert on a phone is a modal the user dismisses before reading, and
    // it blocks the retry.
    if (this.error) {
      form.append(el('p', { class: 'alert', text: this.error, attrs: { role: 'alert' } }))
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void this.submitLogin(nameInput.value, passwordInput.value)
    })

    this.root.replaceChildren(this.header(), form)
  }

  /** The authenticated dashboard. */
  renderDashboard() {
    const user = this.user ?? { name: '', role: '' }

    const identity = el('section', { class: 'card', attrs: { 'data-testid': 'identity' } }, [
      el('h2', { class: 'card__title', text: this.t('auth.currentSession') }),
      el('div', { class: 'status status--online', attrs: { 'data-testid': 'connection' } }, [
        el('span', { text: this.t('local.title') }),
      ]),
      this.row(this.t('auth.name'), user.name),
      // The role is displayed, never used to decide what to fetch. The server
      // already refused anything this account may not see.
      this.row(this.t('local.role'), this.t(`roles.${user.role}`)),
    ])

    const summaryCard = el('section', {
      class: 'card',
      attrs: { 'data-testid': 'manager-summary' },
    })

    if (this.managerDataAllowed && this.summary) {
      summaryCard.append(el('h2', { class: 'card__title', text: this.t('local.summaryTitle') }))
      summaryCard.append(
        this.row(
          this.t('local.openDay'),
          this.summary.open_day ? this.t('local.openDayYes') : this.t('local.openDayNo'),
        ),
      )
    } else {
      // The manager-only section is not merely hidden — it says WHY it is
      // absent, so a STAFF user is not left wondering whether the app is
      // broken. No figure is ever rendered from a 403.
      summaryCard.append(el('h2', { class: 'card__title', text: this.t('local.summaryTitle') }))
      summaryCard.append(
        el('p', {
          class: 'notice',
          text: this.t(this.summaryForbidden ? 'local.forbidden' : 'local.summaryUnavailable'),
          attrs: { role: 'status' },
        }),
      )
    }

    const logout = el('button', {
      class: 'button button--secondary',
      text: this.t('auth.logout'),
      attrs: { type: 'button', id: 'logout' },
    })
    logout.addEventListener('click', () => this.logout())

    this.root.replaceChildren(
      this.header(),
      identity,
      summaryCard,
      logout,
      el('p', { class: 'footer', text: this.t('local.footer') }),
    )
  }

  /** A failure screen for when the app cannot even load its own strings. */
  renderError() {
    this.root.replaceChildren(
      this.header(),
      el('section', { class: 'card' }, [
        el('p', {
          class: 'alert',
          text: this.t('local.connectionLost'),
          attrs: { role: 'alert' },
        }),
        el('button', {
          class: 'button',
          text: this.t('app.retry'),
          attrs: { type: 'button' },
        }),
      ]),
    )
    const retry = this.root.querySelector('button')
    retry?.addEventListener('click', () => void this.start())
  }

  /** Render the current state. */
  render() {
    switch (this.state) {
      case 'loading':
        this.renderLoading()
        break
      case 'dashboard':
        this.renderDashboard()
        break
      case 'error':
        this.renderError()
        break
      case 'login':
      default:
        this.renderLogin()
    }
  }
}
