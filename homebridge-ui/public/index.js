/* global homebridge */
(async () => {
  const $ = (id) => document.getElementById(id);
  const show = (el, visible) => el.classList.toggle('d-none', !visible);
  const RESEND_COOLDOWN_MS = 60_000;
  const REQUEST_TIMEOUT_MS = 45_000;

  let pending = null; // { clientId, region } between "Send code" and "Verify"

  // Config UI X occasionally drops a response; never leave the page spinning forever.
  async function request(path, body) {
    homebridge.showSpinner();
    try {
      return await Promise.race([
        homebridge.request(path, body),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Homebridge UI did not respond. Reload the page and try again.')), REQUEST_TIMEOUT_MS)),
      ]);
    } finally {
      homebridge.hideSpinner();
    }
  }

  function renderDevices({ devices, updatedAt, stale }) {
    const container = $('devices');
    container.replaceChildren();
    if (devices.length === 0) {
      const p = document.createElement('p');
      p.className = 'text-warning';
      p.textContent = 'No mower found on this account. Restart Homebridge after adding one in the Roborock app.';
      container.appendChild(p);
      return;
    }
    for (const device of devices) {
      const row = document.createElement('div');
      row.className = 'mb-2';
      const title = document.createElement('strong');
      title.textContent = device.name;
      const detail = document.createElement('div');
      detail.className = 'small';
      const bits = [device.model, device.online ? (device.mowStateName ?? 'state unknown') : 'offline'];
      if (device.battery !== undefined) {
        bits.push(`battery ${device.battery}%`);
      }
      if (device.fv) {
        bits.push(`firmware ${device.fv}`);
      }
      detail.textContent = bits.join(' · ');
      row.append(title, detail);
      container.appendChild(row);
    }
    const when = document.createElement('p');
    when.className = 'small mt-2';
    const minutes = Math.max(0, Math.round((Date.now() - updatedAt) / 60_000));
    when.textContent = `Last synced ${minutes} min ago${stale ? ' — is Homebridge running?' : ''}.`;
    container.appendChild(when);
  }

  // A freshly installed plugin has no platform block yet; without one Homebridge never starts the platform.
  let platformBlockUnsaved = false;

  async function ensurePlatformBlock() {
    const configs = await homebridge.getPluginConfig();
    if (configs.length > 0) {
      return;
    }
    await homebridge.updatePluginConfig([{ platform: 'RoborockMower' }]);
    platformBlockUnsaved = true;
  }

  async function savePlatformBlockIfNew() {
    if (!platformBlockUnsaved) {
      return;
    }
    await homebridge.savePluginConfig();
    platformBlockUnsaved = false;
  }

  async function render() {
    let email = null;
    let lastError;
    try {
      ({ email, lastError } = await request('/session'));
    } catch (error) {
      homebridge.toast.error(error.message, 'Could not read sign-in state');
    }
    show($('signed-out'), !email);
    show($('signed-in'), Boolean(email));
    show($('session-expired'), lastError === 'session-expired');
    if (!email) {
      return;
    }
    $('signed-in-email').textContent = email;
    try {
      renderDevices(await request('/devices'));
    } catch (error) {
      homebridge.toast.error(error.message, 'Could not load devices');
    }
  }

  $('send-code').addEventListener('click', async () => {
    const email = $('email').value.trim();
    if (!email) {
      homebridge.toast.warning('Enter your Roborock account email.');
      return;
    }
    try {
      pending = await request('/auth/send-code', { email });
      show($('code-step'), true);
      $('code').focus();
      homebridge.toast.success(`Code sent to ${email}.`);
      $('send-code').disabled = true;
      setTimeout(() => { $('send-code').disabled = false; }, RESEND_COOLDOWN_MS);
    } catch (error) {
      homebridge.toast.error(error.message, 'Could not send code');
    }
  });

  $('verify-code').addEventListener('click', async () => {
    const code = $('code').value.trim();
    if (!pending || !code) {
      homebridge.toast.warning('Enter the code from the email.');
      return;
    }
    try {
      await request('/auth/verify-code', { email: $('email').value.trim(), code, ...pending });
      pending = null;
      await savePlatformBlockIfNew();
      homebridge.toast.success('Signed in. Restart Homebridge to apply.');
      await render();
    } catch (error) {
      homebridge.toast.error(error.message, 'Sign-in failed');
    }
  });

  $('sign-out').addEventListener('click', async () => {
    try {
      await request('/auth/sign-out');
      homebridge.toast.info('Signed out. Restart Homebridge to apply.');
    } catch (error) {
      homebridge.toast.error(error.message, 'Sign-out failed');
    }
    await render();
  });

  await ensurePlatformBlock();
  homebridge.showSchemaForm();
  await render();
})();
