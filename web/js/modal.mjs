// Modal layer.
//
// Modals stack (Add emulator -> Browse for the .exe), each one takes over the
// nav scope while it is on top, and closing restores the focus you came from.
// Every modal is fully controller-navigable — there is no flow that requires a
// mouse.

import { h, appendAll, fmtBytes } from './util.mjs';
import * as nav from './nav.mjs';
import { api } from './api.mjs';
import { toast } from './toast.mjs';

/** @type {Array<{el:HTMLElement, scrim:HTMLElement, prevScope:Element, prevKey:string|null, onAction:Function|null, close:Function}>} */
const stack = [];

export function isModalOpen() {
  return stack.length > 0;
}

/** Give the top modal first refusal on an action. @returns {boolean} consumed */
export function handleModalAction(action) {
  if (!stack.length) return false;
  const top = stack[stack.length - 1];

  if (top.onAction && top.onAction(action) === true) return true;

  if (action === 'back') {
    top.close(null);
    return true;
  }
  if (action === 'confirm') {
    nav.activate();
    return true;
  }
  if (['up', 'down', 'left', 'right'].includes(action)) {
    nav.move(action);
    return true;
  }
  // Swallow everything else so the view behind never reacts.
  return true;
}

/**
 * Core modal opener.
 * @param {{
 *   title: string, note?: string,
 *   body?: (ctx: {close: (value:any) => void, rebuild: () => void}) => Node | Node[],
 *   footer?: (ctx: {close: (value:any) => void, rebuild: () => void}) => Node[],
 *   onAction?: (action:string) => boolean,
 *   width?: string,
 * }} spec
 * @returns {Promise<any>} the value passed to close()
 */
export function openModal(spec) {
  const overlayRoot = document.getElementById('overlay-root');

  return new Promise((resolve) => {
    const prevScope = nav.getScope();
    const prevKey = nav.currentKey();
    const prevFocused = nav.getCurrent();

    const scrim = h('div', { class: 'scrim', onClick: () => close(null) });
    const bodyHost = h('div', { class: 'modal-body' });
    const footHost = h('div', { class: 'modal-foot' });

    const modal = h(
      'div',
      {
        class: 'modal',
        role: 'dialog',
        'aria-modal': 'true',
        style: spec.width ? { width: spec.width } : null,
      },
      h(
        'div',
        { class: 'modal-head' },
        h('div', { class: 'modal-title', text: spec.title }),
        spec.note ? h('div', { class: 'modal-note', text: spec.note }) : null,
      ),
      bodyHost,
      footHost,
    );

    const ctx = { close, rebuild };

    function rebuild() {
      bodyHost.replaceChildren();
      footHost.replaceChildren();
      if (spec.body) appendAll(bodyHost, [spec.body(ctx)]);
      const footer = spec.footer ? spec.footer(ctx) : [];
      if (footer && footer.length) appendAll(footHost, [footer]);
      else footHost.remove();
      nav.setScope(modal);
      nav.focusInitial();
    }

    let settled = false;
    function close(value) {
      if (settled) return;
      settled = true;

      const index = stack.findIndex((entry) => entry.el === modal);
      if (index >= 0) stack.splice(index, 1);

      modal.remove();
      scrim.remove();

      // Hand the nav scope back to whoever owned it.
      nav.setScope(prevScope);
      if (!nav.focusKey(prevKey)) {
        if (prevFocused && prevFocused.isConnected) nav.focus(prevFocused, { scroll: false });
        else nav.focusInitial();
      }

      resolve(value);
    }

    overlayRoot.append(scrim, modal);
    stack.push({ el: modal, scrim, prevScope, prevKey, onAction: spec.onAction || null, close });
    rebuild();
  });
}

// ------------------------------------------------------------- shorthands

export function confirmModal({
  title,
  note,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
}) {
  return openModal({
    title,
    note,
    width: '480px',
    footer: ({ close }) => [
      h('button', { class: 'btn btn-ghost', nav: true, onClick: () => close(false), text: cancelLabel }),
      h('button', {
        class: ['btn', danger ? 'btn-danger' : 'btn-primary'],
        nav: true,
        'data-nav-initial': '',
        onClick: () => close(true),
        text: confirmLabel,
      }),
    ],
  }).then((value) => value === true);
}

/**
 * Single-choice list.
 * @param {{title:string, note?:string, options:Array<{id:string,title:string,note?:string,selected?:boolean,disabled?:boolean}>, allowNone?:string}} spec
 * @returns {Promise<string|null>}
 */
export function chooseModal({ title, note, options, allowNone = null }) {
  return openModal({
    title,
    note,
    body: ({ close }) =>
      h(
        'div',
        { class: 'choices' },
        ...options.map((option) =>
          h(
            'button',
            {
              class: ['choice', option.selected && 'is-selected'],
              nav: true,
              'data-nav-key': `choice-${option.id}`,
              'data-nav-initial': option.selected ? '' : null,
              'aria-disabled': option.disabled ? 'true' : null,
              onClick: () => {
                if (!option.disabled) close(option.id);
              },
            },
            h(
              'div',
              {},
              h('div', { class: 'choice-title', text: option.title }),
              option.note ? h('div', { class: 'choice-note', text: option.note }) : null,
            ),
            option.selected ? h('div', { class: 'chip chip-strong', text: 'Current' }) : null,
          ),
        ),
        allowNone
          ? h(
              'button',
              {
                class: 'choice',
                nav: true,
                onClick: () => close('__none__'),
              },
              h('div', {}, h('div', { class: 'choice-title', text: allowNone })),
            )
          : null,
      ),
    footer: ({ close }) => [
      h('button', { class: 'btn btn-ghost', nav: true, onClick: () => close(null), text: 'Cancel' }),
    ],
  });
}

/**
 * Path picker. Offers the OS dialog when available, and always offers the
 * built-in controller-navigable browser.
 * @param {{kind:'folder'|'executable'|'image', title?:string, start?:string, nativeDialogs?:boolean}} spec
 * @returns {Promise<string|null>}
 */
export function browseModal({ kind, title, start, nativeDialogs = false }) {
  const wantsFolder = kind === 'folder';
  const heading = title || (wantsFolder ? 'Choose a folder' : 'Choose a file');
  let state = { path: start ?? null, listing: null, loading: true, error: null };

  return openModal({
    title: heading,
    note: wantsFolder
      ? 'Pick the folder that holds the ROMs. Sub-folders are included.'
      : 'Pick the program to launch games with.',
    width: '760px',
    body: (ctx) => {
      const host = h('div', {});

      const render = () => {
        host.replaceChildren();

        if (state.loading) {
          host.append(h('div', { class: 'dim', text: 'Reading folder…' }));
          return;
        }
        if (state.error) {
          host.append(h('div', { class: 'dim', text: state.error }));
        }

        const listing = state.listing;
        host.append(h('div', { class: 'browser-path', text: listing?.display || 'This PC' }));

        const list = h('div', { class: 'browser-list' });

        if (listing?.parent !== null && listing?.parent !== undefined) {
          list.append(
            h(
              'button',
              { class: 'browser-item', nav: true, onClick: () => go(listing.parent) },
              h('div', { class: 'icon', text: '↰' }),
              h('div', { class: 'name', text: 'Up one level' }),
              h('div', {}),
            ),
          );
        }

        for (const dir of listing?.dirs || []) {
          list.append(
            h(
              'button',
              {
                class: 'browser-item',
                nav: true,
                'data-nav-key': `dir-${dir.path}`,
                onClick: () => go(dir.path),
              },
              h('div', { class: 'icon', text: '▸' }),
              h('div', { class: 'name', text: dir.name }),
              h('div', { class: 'size', text: wantsFolder ? 'open' : '' }),
            ),
          );
        }

        if (!wantsFolder) {
          for (const file of listing?.files || []) {
            list.append(
              h(
                'button',
                {
                  class: 'browser-item',
                  nav: true,
                  'data-nav-key': `file-${file.path}`,
                  onClick: () => ctx.close(file.path),
                },
                h('div', { class: 'icon', text: '•' }),
                h('div', { class: 'name', text: file.name }),
                h('div', { class: 'size', text: fmtBytes(file.size) }),
              ),
            );
          }
        }

        if (!list.children.length) {
          list.append(h('div', { class: 'dim', text: 'Nothing here.' }));
        }
        host.append(list);
      };

      const go = async (path) => {
        state = { ...state, loading: true, error: null };
        render();
        try {
          const listing = await api.browse(path, wantsFolder ? 'folders' : kind);
          state = { path: listing.path, listing, loading: false, error: listing.error || null };
        } catch (err) {
          state = { ...state, loading: false, error: err.message };
        }
        render();
        nav.focusInitial();
      };

      render();
      go(state.path);
      return host;
    },
    footer: (ctx) => {
      const buttons = [];

      if (nativeDialogs) {
        buttons.push(
          h('button', {
            class: 'btn btn-ghost',
            nav: true,
            text: 'Use system dialog…',
            onClick: async () => {
              try {
                const result = await api.dialog(
                  wantsFolder ? 'folder' : kind === 'image' ? 'image' : 'executable',
                  state.path || '',
                  heading,
                );
                if (result.path) ctx.close(result.path);
              } catch (err) {
                toast.error(err.message);
              }
            },
          }),
        );
      }

      buttons.push(
        h('button', { class: 'btn btn-ghost', nav: true, text: 'Cancel', onClick: () => ctx.close(null) }),
      );

      if (wantsFolder) {
        buttons.push(
          h('button', {
            class: 'btn btn-primary',
            nav: true,
            'data-nav-initial': '',
            text: 'Use this folder',
            onClick: () => {
              if (state.path) ctx.close(state.path);
              else toast.error('Open a folder first.');
            },
          }),
        );
      }

      return buttons;
    },
  });
}
