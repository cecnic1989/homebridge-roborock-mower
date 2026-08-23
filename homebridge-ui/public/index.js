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

  function renderDevices({ mowers, otherDeviceCount }) {
    const container = $('devices');
    container.replaceChildren();
    if (mowers.length === 0) {
      const p = document.createElement('p');
      p.className = 'text-warning';
      p.textContent = `No mower found on this account (${otherDeviceCount} other Roborock device(s)).`;
      container.appendChild(p);
      return;
    }
    for (const mower of mowers) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${mower.name} — ${mower.model}${mower.online === false ? ' (offline)' : ''}`;
      const pre = document.createElement('pre');
      pre.className = 'small mt-2';
      pre.textContent = JSON.stringify(mower, null, 2);
      details.append(summary, pre);
      container.appendChild(details);
    }
  }

  async function render() {
    let email = null;
    try {
      ({ email } = await request('/session'));
    } catch (error) {
      homebridge.toast.error(error.message, 'Could not read sign-in state');
    }
    show($('signed-out'), !email);
    show($('signed-in'), Boolean(email));
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

  homebridge.showSchemaForm();
  await render();
})();
