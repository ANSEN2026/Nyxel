import iconUrl from '../assets/app-icon.png';
import type { AccountState, AccountUser, ToastApi } from '../types';

type AccountMode = 'register' | 'login';
type AccountTab = 'email' | 'wechat';

export class AccountView {
  readonly element: HTMLElement;

  private toast: ToastApi;
  private onChange: (user: AccountUser | null) => void;
  private state: AccountState | null = null;
  private mode: AccountMode = 'register';
  private tab: AccountTab = 'email';
  private busy = false;

  private panel: HTMLElement;
  private authPane: HTMLElement;
  private profilePane: HTMLElement;
  private tabEmail: HTMLButtonElement;
  private tabWechat: HTMLButtonElement;
  private emailPanel: HTMLElement;
  private wechatPanel: HTMLElement;
  private formTitle: HTMLElement;
  private formDesc: HTMLElement;
  private emailInput: HTMLInputElement;
  private nameInput: HTMLInputElement;
  private passwordInput: HTMLInputElement;
  private confirmInput: HTMLInputElement;
  private submitButton: HTMLButtonElement;
  private passwordToggle: HTMLButtonElement;
  private resetButton: HTMLButtonElement;
  private errorBox: HTMLElement;
  private registerOnly: HTMLElement[];
  private wechatEmailButton: HTMLButtonElement;
  private profileAvatar: HTMLElement;
  private profileName: HTMLElement;
  private profileEmail: HTMLElement;
  private profileCreated: HTMLElement;

  constructor(toast: ToastApi, onChange: (user: AccountUser | null) => void) {
    this.toast = toast;
    this.onChange = onChange;
    this.element = document.createElement('div');
    this.element.className = 'account-overlay hidden';
    this.element.innerHTML = `
      <div class="account-panel" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <div class="account-ambient" aria-hidden="true"></div>
        <header class="account-header">
          <div class="account-brand">
            <img src="${iconUrl}" alt="" draggable="false">
            <div>
              <h2 id="account-title">Texture map 账号</h2>
              <p>一个本机账号，记录你的使用身份</p>
            </div>
          </div>
          <button class="ghost account-close" type="button" data-action="close" title="关闭">×</button>
        </header>

        <div class="account-body">
          <section class="account-auth" data-pane="auth">
            <div class="account-tabs" role="tablist" aria-label="注册方式">
              <button class="account-tab active" type="button" role="tab" aria-selected="true" data-tab="email">邮箱注册</button>
              <button class="account-tab" type="button" role="tab" aria-selected="false" data-tab="wechat">微信扫码</button>
            </div>

            <div class="account-tab-panel" data-panel="email">
              <div class="account-form-head">
                <div>
                  <h3 data-role="form-title">创建本机账号</h3>
                  <p data-role="form-desc">账号只保存在这台电脑，不会上传。</p>
                </div>
                <span class="account-local-tag">仅本机</span>
              </div>

              <div class="account-fields">
                <label class="account-field">
                  <span>邮箱</span>
                  <input id="account-email" type="email" maxlength="254" autocomplete="email" spellcheck="false" placeholder="you@example.com">
                </label>
                <label class="account-field" data-register-only>
                  <span>昵称 <em>可选</em></span>
                  <input id="account-name" type="text" maxlength="24" autocomplete="nickname" placeholder="怎么称呼你？">
                </label>
                <label class="account-field">
                  <span>密码</span>
                  <div class="account-password">
                    <input id="account-password" type="password" maxlength="128" autocomplete="new-password" placeholder="至少 6 位">
                    <button type="button" class="account-reveal" data-action="reveal">显示</button>
                  </div>
                </label>
                <label class="account-field" data-register-only>
                  <span>确认密码</span>
                  <input id="account-confirm" type="password" maxlength="128" autocomplete="new-password" placeholder="再输入一次">
                </label>
              </div>

              <div class="account-error" data-role="error" role="alert"></div>
              <button class="account-submit primary" type="button" data-action="submit">创建账号</button>
              <button class="account-forgot hidden" type="button" data-action="reset">忘记密码？清除本机账号</button>
              <p class="account-fineprint">密码以加盐摘要保存在本机，不上传网络。更换电脑后需要重新注册。</p>
            </div>

            <div class="account-tab-panel hidden" data-panel="wechat">
              <div class="account-wechat">
                <div class="account-qr-frame" aria-hidden="true">
                  <div class="account-wechat-mark">
                    <svg viewBox="0 0 64 64">
                      <path d="M27 10C15.4 10 6 17.8 6 27.4c0 5.3 3.1 10.1 8 13.1l-2 6.2 7.2-3.7c2.4.7 4.9 1.1 7.8 1.1 11.6 0 21-7.8 21-17.4S38.6 10 27 10Z"/>
                      <path d="M43 27c8.3 0 15 5.3 15 11.9 0 3.8-2.2 7.2-5.8 9.5l1.6 4.8-5.5-2.8c-1.7.5-3.5.8-5.3.8-8.3 0-15-5.3-15-11.9S34.7 27 43 27Z"/>
                      <circle cx="20" cy="24" r="2.4"/>
                      <circle cx="34" cy="24" r="2.4"/>
                      <circle cx="37.5" cy="36.5" r="1.9"/>
                      <circle cx="48.5" cy="36.5" r="1.9"/>
                    </svg>
                  </div>
                  <span class="account-qr-badge">待接入</span>
                </div>
                <h3>微信扫码注册</h3>
                <p>微信扫码需要微信开放平台应用和公网回调服务器。当前版本先用邮箱创建本机账号。</p>
                <button class="primary" type="button" data-action="wechat-email">用邮箱注册</button>
                <div class="account-wechat-status"><span></span>微信扫码服务未配置</div>
              </div>
            </div>
          </section>

          <section class="account-profile hidden" data-pane="profile">
            <div class="account-avatar" data-role="avatar">T</div>
            <h3 data-role="profile-name">Texture map 用户</h3>
            <p class="account-profile-email" data-role="profile-email"></p>
            <span class="account-local-tag account-profile-tag">本机账号</span>
            <div class="account-profile-info">
              <span>注册时间</span>
              <strong data-role="profile-created"></strong>
            </div>
            <p class="account-profile-note">账号信息保存在本机，不会同步到其他设备，也不会上传网络。</p>
            <div class="account-profile-actions">
              <button class="ghost" type="button" data-action="logout">退出登录</button>
              <button class="primary" type="button" data-action="profile-close">完成</button>
            </div>
          </section>
        </div>
      </div>
    `;

    this.panel = this.query('.account-panel');
    this.authPane = this.query('[data-pane="auth"]');
    this.profilePane = this.query('[data-pane="profile"]');
    this.tabEmail = this.query('[data-tab="email"]');
    this.tabWechat = this.query('[data-tab="wechat"]');
    this.emailPanel = this.query('[data-panel="email"]');
    this.wechatPanel = this.query('[data-panel="wechat"]');
    this.formTitle = this.query('[data-role="form-title"]');
    this.formDesc = this.query('[data-role="form-desc"]');
    this.emailInput = this.query('#account-email');
    this.nameInput = this.query('#account-name');
    this.passwordInput = this.query('#account-password');
    this.confirmInput = this.query('#account-confirm');
    this.submitButton = this.query('[data-action="submit"]');
    this.passwordToggle = this.query('[data-action="reveal"]');
    this.resetButton = this.query('[data-action="reset"]');
    this.errorBox = this.query('[data-role="error"]');
    this.registerOnly = Array.from(this.element.querySelectorAll<HTMLElement>('[data-register-only]'));
    this.wechatEmailButton = this.query('[data-action="wechat-email"]');
    this.profileAvatar = this.query('[data-role="avatar"]');
    this.profileName = this.query('[data-role="profile-name"]');
    this.profileEmail = this.query('[data-role="profile-email"]');
    this.profileCreated = this.query('[data-role="profile-created"]');

    this.bindEvents();
  }

  async open(): Promise<void> {
    this.element.classList.remove('hidden');
    this.setError('');
    this.setBusy(false);
    try {
      this.applyState(await window.nyxel.account.status(), false);
    } catch (error) {
      this.setError(error instanceof Error ? error.message : String(error));
    }

    if (this.state?.user) {
      this.profilePane.querySelector<HTMLButtonElement>('[data-action="profile-close"]')?.focus();
      return;
    }

    this.mode = this.state?.hasAccount ? 'login' : 'register';
    this.applyMode(this.mode);
    this.emailInput.value = this.state?.email ?? '';
    this.setTab('email');
    window.setTimeout(() => {
      if (this.mode === 'login') this.passwordInput.focus();
      else this.emailInput.focus();
    }, 40);
  }

  close(): void {
    this.element.classList.add('hidden');
    this.passwordInput.value = '';
    this.confirmInput.value = '';
    this.setError('');
  }

  private query<T extends Element>(selector: string): T {
    return this.element.querySelector(selector) as T;
  }

  private bindEvents(): void {
    this.element.querySelector('[data-action="close"]')?.addEventListener('click', () => this.close());
    this.element.addEventListener('click', (event) => {
      if (event.target === this.element) this.close();
    });

    this.tabEmail.addEventListener('click', () => this.setTab('email'));
    this.tabWechat.addEventListener('click', () => this.setTab('wechat'));
    this.wechatEmailButton.addEventListener('click', () => {
      this.setTab('email');
      this.setError('');
    });

    this.submitButton.addEventListener('click', () => void this.submit());
    this.passwordToggle.addEventListener('click', () => this.togglePasswordVisibility());
    this.resetButton.addEventListener('click', () => void this.resetAccount());
    this.element.querySelector('[data-action="logout"]')?.addEventListener('click', () => void this.logout());
    this.element.querySelector('[data-action="profile-close"]')?.addEventListener('click', () => this.close());

    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement && this.tab === 'email') {
        event.preventDefault();
        void this.submit();
      }
    });
  }

  private applyState(state: AccountState, notify = true): void {
    this.state = state;
    this.authPane.classList.toggle('hidden', Boolean(state.user));
    this.profilePane.classList.toggle('hidden', !state.user);
    this.wechatEmailButton.textContent = state.hasAccount ? '用邮箱登录' : '用邮箱注册';

    if (state.user) {
      this.renderProfile(state.user);
      this.onChange(state.user);
    } else {
      this.mode = state.hasAccount ? 'login' : 'register';
      this.applyMode(this.mode);
      this.onChange(null);
    }
    if (notify) this.setError('');
  }

  private renderProfile(user: AccountUser): void {
    const initial = Array.from(user.displayName.trim())[0] || 'T';
    this.profileAvatar.textContent = initial.toUpperCase();
    this.profileName.textContent = user.displayName;
    this.profileEmail.textContent = user.email;
    this.profileCreated.textContent = formatDate(user.createdAt);
  }

  private applyMode(mode: AccountMode): void {
    this.mode = mode;
    const register = mode === 'register';
    this.formTitle.textContent = register ? '创建本机账号' : '登录本机账号';
    this.formDesc.textContent = register
      ? '账号只保存在这台电脑，不会上传。'
      : '输入本机账号的邮箱和密码。';
    this.submitButton.textContent = register ? '创建账号' : '登录';
    this.tabEmail.textContent = register ? '邮箱注册' : '邮箱登录';
    this.registerOnly.forEach((element) => element.classList.toggle('hidden', !register));
    this.resetButton.classList.toggle('hidden', register || !this.state?.hasAccount);
    this.passwordInput.autocomplete = register ? 'new-password' : 'current-password';
    this.passwordInput.placeholder = register ? '至少 6 位' : '输入密码';
    this.emailInput.value = this.state?.email ?? this.emailInput.value;
    this.setError('');
    this.updatePasswordToggleLabel();
  }

  private setTab(tab: AccountTab): void {
    this.tab = tab;
    const email = tab === 'email';
    this.tabEmail.classList.toggle('active', email);
    this.tabWechat.classList.toggle('active', !email);
    this.tabEmail.setAttribute('aria-selected', String(email));
    this.tabWechat.setAttribute('aria-selected', String(!email));
    this.emailPanel.classList.toggle('hidden', !email);
    this.wechatPanel.classList.toggle('hidden', email);
    this.setError('');
  }

  private togglePasswordVisibility(): void {
    const reveal = this.passwordInput.type === 'password';
    this.passwordInput.type = reveal ? 'text' : 'password';
    this.passwordToggle.textContent = reveal ? '隐藏' : '显示';
  }

  private updatePasswordToggleLabel(): void {
    this.passwordInput.type = 'password';
    this.passwordToggle.textContent = '显示';
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.submitButton.disabled = busy;
    this.submitButton.textContent = busy
      ? '处理中…'
      : this.mode === 'register'
        ? '创建账号'
        : '登录';
  }

  private setError(message: string): void {
    this.errorBox.textContent = message;
    this.errorBox.classList.toggle('show', Boolean(message));
    if (!message) return;
    this.panel.classList.remove('account-shake');
    void this.panel.offsetWidth;
    this.panel.classList.add('account-shake');
  }

  private async submit(): Promise<void> {
    if (this.busy || this.state?.user || this.tab !== 'email') return;
    const email = this.emailInput.value.trim();
    const password = this.passwordInput.value;
    const displayName = this.nameInput.value.trim();
    const register = this.mode === 'register';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      this.setError('请输入有效的邮箱地址');
      this.emailInput.focus();
      return;
    }
    if (password.length < 6) {
      this.setError('密码至少需要 6 个字符');
      this.passwordInput.focus();
      return;
    }
    if (register && password !== this.confirmInput.value) {
      this.setError('两次输入的密码不一致');
      this.confirmInput.focus();
      return;
    }

    this.setError('');
    this.setBusy(true);
    try {
      const result = register
        ? await window.nyxel.account.register({ email, password, displayName })
        : await window.nyxel.account.login({ email, password });
      if (!result.ok || !result.state) {
        this.setError(result.error ?? '操作失败，请稍后再试');
        return;
      }
      this.applyState(result.state);
      this.passwordInput.value = '';
      this.confirmInput.value = '';
      const user = result.state.user;
      this.onLogin?.(user);
      this.toast(
        register
          ? `本机账号已创建，欢迎 ${user?.displayName ?? ''}`
          : `欢迎回来，${user?.displayName ?? ''}`,
        'success'
      );
    } catch (error) {
      this.setError(error instanceof Error ? error.message : String(error));
    } finally {
      this.setBusy(false);
    }
  }

  private async logout(): Promise<void> {
    try {
      const result = await window.nyxel.account.logout();
      if (!result.ok || !result.state) {
        this.toast(result.error ?? '退出登录失败', 'error');
        return;
      }
      this.applyState(result.state);
      this.setTab('email');
      this.toast('已退出本机账号', 'success');
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private async resetAccount(): Promise<void> {
    try {
      const result = await window.nyxel.account.reset();
      if (!result.ok) {
        if (result.error && result.error !== '已取消') this.setError(result.error);
        return;
      }
      this.applyState(result.state ?? { hasAccount: false, user: null, storagePath: '' });
      this.emailInput.value = '';
      this.nameInput.value = '';
      this.passwordInput.value = '';
      this.confirmInput.value = '';
      this.setTab('email');
      this.toast('本机账号已清除，可以重新注册', 'success');
    } catch (error) {
      this.setError(error instanceof Error ? error.message : String(error));
    }
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '—';
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}
