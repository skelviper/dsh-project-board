// Project board styles (scoped; DSH alias tokens for light/dark themes).
const PB_CSS = `
.pb-page{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#242a2d);font-size:14px;font-family:inherit}
.pb-page *{box-sizing:border-box}
.pb-page button:where([class^="pb-"],[class*=" pb-"]){font:inherit;cursor:pointer;color:inherit}
.pb-page input,.pb-page textarea,.pb-page select{font:inherit}
.pb-page ::-webkit-scrollbar{width:8px;height:8px}
.pb-page ::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,#d8dbde);border-radius:8px}
.pb-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:calc(10px + var(--dsh-frame-top-clearance,0px)) 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8ea)}
.pb-title{font-size:17px;font-weight:650;margin:0;white-space:nowrap}
.pb-ws{display:flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:8px;padding:4px 8px;background:var(--dsw-alias-bg-base,#fff);max-width:340px}
.pb-ws select{border:0;background:transparent;color:inherit;outline:none;max-width:260px}
.pb-meta{color:var(--dsw-alias-label-tertiary,#8a9298);font-size:12px}
.pb-spacer{flex:1}
.pb-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1,#e6e8ea);background:var(--dsw-alias-bg-base,#fff);border-radius:8px;padding:5px 10px;color:var(--dsw-alias-label-primary,#242a2d);white-space:nowrap;font-size:13px;cursor:pointer;transition:background .12s,border-color .12s}
.pb-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}
.pb-btn.primary{background:var(--dsw-alias-brand-primary,#0f1115);border-color:var(--dsw-alias-brand-primary,#0f1115);color:var(--dsw-alias-label-primary-inverted,#fff)}
.pb-btn.primary:hover{filter:brightness(1.05)}
.pb-btn.danger{color:#c0574d}
.pb-btn[disabled]{opacity:.5;cursor:default}
.pb-btn.small{padding:3px 7px;font-size:12px}
.pb-btn.on{background:color-mix(in srgb, ${PB_ACCENT} 10%, transparent);border-color:${PB_ACCENT};color:${PB_ACCENT}}
.pb-body{flex:1;display:flex;min-height:0;position:relative}
.pb-canvas-wrap{flex:1;min-width:0;position:relative;overflow:hidden;background:var(--dsw-alias-bg-base,#fff)}
.pb-connect-select{max-width:230px;min-width:0;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font-size:12.5px!important}
.pb-connection-guide{position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:4;display:flex;gap:10px;align-items:center;max-width:calc(100% - 24px);padding:8px 12px;border:1px solid color-mix(in srgb,${PB_ACCENT} 30%,transparent);border-radius:9px;background:var(--dsw-alias-bg-elevated,#fff);box-shadow:0 2px 10px rgba(20,30,35,.07);font-size:12px;pointer-events:none}
.pb-connection-guide>span:first-child{min-width:0;overflow-wrap:anywhere}
.pb-connection-guide>.pb-meta{flex:none;white-space:nowrap}
.pb-connecting .pb-node{cursor:crosshair}
.pb-node[role=button]:focus-visible{outline:2px solid ${PB_ACCENT};outline-offset:3px}
.pb-node-membership{margin-top:8px;color:var(--dsw-alias-label-secondary,#6f777d);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.pb-grid{position:absolute;inset:0;background-image:radial-gradient(circle,var(--dsw-alias-border-l2,#d8dbde) 1px,transparent 1px);background-size:24px 24px;opacity:.55;pointer-events:none}
.pb-scene{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;will-change:transform}
.pb-marquee{position:absolute;z-index:5;border:1.5px solid ${PB_ACCENT};border-radius:4px;background:color-mix(in srgb,${PB_ACCENT} 10%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,${PB_ACCENT} 18%,transparent) inset;pointer-events:none}
.pb-marquee-active{cursor:crosshair}
.pb-selection-pill{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:4;display:flex;align-items:center;gap:9px;max-width:min(620px,calc(100% - 240px));padding:5px 8px 5px 11px;border:1px solid color-mix(in srgb,${PB_ACCENT} 30%,transparent);border-radius:9px;background:var(--dsw-alias-bg-elevated,#fff);box-shadow:0 2px 10px rgba(20,30,35,.1);font-size:12px;color:var(--dsw-alias-label-primary,#242a2d);white-space:nowrap}
.pb-selection-pill>.pb-meta{min-width:0;overflow:hidden;text-overflow:ellipsis}
.pb-selection-count{font-weight:600;color:${PB_ACCENT}}
.pb-edges{position:absolute;left:-5000px;top:-5000px;width:10000px;height:10000px;overflow:visible;pointer-events:none}
.pb-edge{fill:none;stroke:#93a6af;stroke-width:1.7;stroke-linejoin:round;stroke-linecap:round;pointer-events:none}
.pb-edge-hit{fill:none;stroke:transparent;stroke-width:14;stroke-linejoin:round;stroke-linecap:round;pointer-events:stroke;cursor:pointer;outline:none}
.pb-edge-hit:hover+.pb-edge,.pb-edge-hit:focus-visible+.pb-edge{stroke:#4d6bfe;stroke-width:2.6}
.pb-edge-menu{position:absolute;z-index:6;width:270px;max-width:calc(100% - 16px);padding:7px;border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:11px;background:var(--dsw-alias-bg-elevated,#fff);box-shadow:0 8px 24px rgba(20,24,28,.16);cursor:default}
.pb-edge-menu-head{display:flex;align-items:center;gap:6px;padding:2px 5px 5px}
.pb-edge-menu-title{padding:0 5px 7px;color:var(--dsw-alias-label-secondary,#6f777d);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb-edge-delete{display:flex;align-items:center;gap:7px;width:100%;padding:8px;border:0;border-radius:7px;background:transparent;color:#c0574d!important;text-align:left;font-size:13px}
.pb-edge-delete:hover{background:rgba(192,87,77,.08)}
.pb-edge-delete:disabled{opacity:.5;cursor:default}
.pb-edge-menu-error{padding:7px 5px;color:#c0574d;font-size:12px;overflow-wrap:anywhere}
.pb-edge.contains{stroke:#93a6af;stroke-width:1.6}
.pb-edge.depends{stroke:#b8863a;stroke-width:1.9;stroke-dasharray:6 4}
.pb-edge.produces{stroke:#4f9a85;stroke-width:2}
.pb-node{position:absolute;width:230px;border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:10px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 1px 3px rgba(20,30,35,.06);padding:10px 11px;cursor:grab;user-select:none;display:flex;flex-direction:column;gap:6px;transition:box-shadow .12s,border-color .12s}
.pb-node:hover{box-shadow:0 3px 10px rgba(20,30,35,.10)}
.pb-node.selected{border-color:${PB_ACCENT};box-shadow:0 0 0 2px color-mix(in srgb, ${PB_ACCENT} 16%, transparent),0 4px 14px rgba(20,30,35,.08)}
.pb-node.dragging{cursor:grabbing}
.pb-node-head{display:flex;align-items:center;gap:7px;min-width:0}
.pb-node-kind{width:22px;height:22px;flex:none;border-radius:6px;display:grid;place-items:center;background:var(--dsw-specific-tip,#f3f5f6)}
.pb-node-title{font-weight:650;font-size:13.5px;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.pb-node-summary{color:var(--dsw-alias-label-secondary,#6f777d);font-size:12px;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.pb-node-foot{display:flex;align-items:center;gap:7px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#8a9298);font-size:11.5px}
.pb-node-tasks{display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--dsw-alias-border-l1,#e6e8ea);padding-top:5px;min-width:0}
.pb-node-task{display:flex;align-items:center;gap:7px;min-width:0;width:100%;height:24px;padding:2px 3px;border:0;border-radius:5px;background:transparent;text-align:left}
.pb-node-task:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}
.pb-node-task-title{flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb-execution-badge{display:inline-flex;align-items:center;gap:4px;flex:none;white-space:nowrap;font-size:10.5px;line-height:18px;padding:0 5px;border-radius:5px;color:var(--dsw-alias-label-secondary,#6f777d);background:var(--dsw-specific-tip,#f3f5f6);font-weight:400}
.pb-execution-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.pb-execution-badge.running{color:#4d6bfe;background:rgba(77,107,254,.09)}
.pb-execution-badge.ready{color:#288d77;background:rgba(40,141,119,.10)}
.pb-execution-badge.waiting{color:#b8863a;background:rgba(184,134,58,.10)}
.pb-execution-badge.stopped,.pb-execution-badge.blocked{color:#c0574d;background:rgba(192,87,77,.09)}
.pb-execution-badge.running .pb-execution-dot{animation:pb-running-pulse 1.4s ease-in-out infinite}
.pb-todo-title-line{display:flex;align-items:flex-start;gap:7px;min-width:0}
.pb-todo-title-line>.pb-todo-title{flex:1;min-width:0}
@keyframes pb-running-pulse{50%{opacity:.3}}
@media(prefers-reduced-motion:reduce){.pb-execution-badge.running .pb-execution-dot{animation:none}}
.pb-node-task:focus-visible,.pb-node-tasks-all:focus-visible{outline:2px solid ${PB_ACCENT};outline-offset:1px}
.pb-node-task:disabled,.pb-node-tasks-all:disabled{cursor:default}
.pb-node-tasks-all{border:0;font-size:11px!important}
.pb-node-tasks-all:hover{color:${PB_ACCENT}}
.pb-node-done-count{margin-left:auto;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary,#6f777d)}
.pb-task-row.pb-task-focused{outline:2px solid ${PB_ACCENT};outline-offset:1px}
.pb-task-row:focus{outline:2px solid ${PB_ACCENT};outline-offset:1px}
.pb-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#a0a5aa}
.pb-progress{height:4px;border-radius:4px;background:var(--dsw-specific-tip,#eceff1);overflow:hidden}
.pb-progress>span{display:block;height:100%;background:${PB_ACCENT};border-radius:4px}
.pb-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:6px;background:var(--dsw-specific-tip,#f3f5f6);font-size:11px;color:var(--dsw-alias-label-secondary,#6f777d);white-space:nowrap}
.pb-toolbar{position:absolute;left:12px;bottom:12px;display:flex;align-items:center;gap:6px;padding:5px;border:1px solid var(--dsw-alias-border-l1,#e6e8ea);background:var(--dsw-alias-bg-elevated,#fff);border-radius:9px;box-shadow:0 2px 10px rgba(20,30,35,.08);z-index:3}
.pb-legend{position:absolute;right:12px;bottom:12px;display:flex;gap:9px;flex-wrap:wrap;justify-content:flex-end;max-width:70%;padding:5px 8px;border-radius:8px;background:var(--dsw-alias-bg-elevated,#fff);border:1px solid var(--dsw-alias-border-l1,#e6e8ea);color:var(--dsw-alias-label-secondary,#6f777d);font-size:11.5px;z-index:2}
.pb-legend span{display:inline-flex;align-items:center;gap:4px}
.pb-dock{flex:none;min-width:0;max-width:none;border-left:1px solid var(--dsw-alias-border-l1,#e6e8ea);display:flex;flex-direction:column;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff)}
.pb-dock-resizer{width:7px;flex:none;cursor:col-resize;position:relative;background:transparent;touch-action:none}
.pb-dock-resizer::after{content:'';position:absolute;left:3px;top:0;bottom:0;width:1px;background:var(--dsw-alias-border-l1,#e6e8ea);transition:background .12s,width .12s}
.pb-dock-resizer:hover::after,.pb-dock-resizer:active::after{background:${PB_ACCENT};width:2px;left:2.5px}
.pb-dock-tabs{display:flex;gap:2px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8ea);flex:none}
.pb-inspector{width:100%;flex:1;border-left:0;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base,#fff)}
.pb-assistant{flex:1;display:flex;flex-direction:column;min-height:0}
.pb-assistant-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8ea)}
.pb-assistant-title{font-size:14px;font-weight:650}
.pb-assistant-sub{color:var(--dsw-alias-label-tertiary,#8a9298);font-size:11.5px;margin-top:2px}
.pb-assistant-body{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px;min-height:0}
.pb-assistant-status{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#6f777d);font-size:12px;padding:4px 2px}
.pb-assistant-foot{border-top:1px solid var(--dsw-alias-border-l1,#e6e8ea);padding:10px 12px;display:flex;flex-direction:column;gap:7px}
.pb-assistant-foot .pb-textarea{min-height:58px;max-height:160px}
.pb-assistant-actions{display:flex;align-items:center;gap:6px}
.pb-conversation-anchor{display:inline-flex;min-width:0;flex:none}
.pb-conversation-trigger,.pb-conversation-options{display:inline-flex;align-items:center;justify-content:center;gap:5px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#6f777d);padding:4px 6px;max-width:240px;font-size:12px;white-space:nowrap;cursor:pointer}
.pb-conversation-options{padding:4px 3px}
.pb-conversation-trigger:disabled,.pb-conversation-options:disabled{opacity:.6;cursor:wait}
.pb-conversation-trigger>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.pb-conversation-trigger:hover,.pb-conversation-trigger.open,.pb-conversation-options:hover,.pb-conversation-options.open{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6);color:var(--dsw-alias-label-primary,#242a2d)}
.pb-thread-menu{position:fixed;z-index:1000;box-sizing:border-box;overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:12px;background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,#242a2d);font-family:inherit;font-size:13px;box-shadow:0 12px 32px rgba(20,24,28,.16),0 2px 6px rgba(20,24,28,.06)}
.pb-thread-menu *{box-sizing:border-box}
.pb-thread-menu button{font:inherit;color:inherit;cursor:pointer}
.pb-thread-menu button:focus-visible,.pb-conversation-trigger:focus-visible,.pb-conversation-options:focus-visible,.pb-dock-resizer:focus-visible{outline:2px solid #4d6bfe;outline-offset:-2px}
.pb-thread-menu-heading{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a9298);padding:6px 8px}
.pb-thread-menu-line{display:flex;align-items:center;border-radius:8px}
.pb-thread-menu-line:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}
.pb-thread-menu-choice{display:flex;align-items:center;gap:8px;min-width:0;flex:1;text-align:left;border:0;border-radius:8px;background:transparent;padding:8px}
.pb-thread-menu-choice[aria-checked=true]{background:rgba(77,107,254,.08)}
.pb-thread-menu-text{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.pb-thread-menu-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb-thread-menu-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9298)}
.pb-thread-menu-remove{flex:none;display:grid;place-items:center;border:0;border-radius:6px;padding:6px;background:transparent;opacity:.65}
.pb-thread-menu-remove:hover{color:#c0574d;background:rgba(192,87,77,.08);opacity:1}
.pb-thread-menu-create{display:flex;align-items:center;gap:8px;width:100%;padding:9px 8px;border:0;border-top:1px solid var(--dsw-alias-border-l1,#e6e8ea);background:transparent;border-radius:6px;text-align:left}
.pb-thread-menu-create:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}
.pb-thread-menu-empty,.pb-thread-menu-error{padding:10px 8px;color:var(--dsw-alias-label-tertiary,#8a9298);font-size:12px}
.pb-thread-menu-error,.pb-conversation-error{color:#c0574d;overflow-wrap:anywhere}
.pb-conversation-heading{flex:1;min-width:0}
.pb-conversation-meta,.pb-conversation-controls{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}
.pb-conversation-controls .pb-conversation-anchor{flex:0 1 auto}
.pb-note-form>.pb-btn{flex:none}
.pb-dock-tabs{flex-wrap:wrap}
.pb-assistant-actions{flex-wrap:wrap}
.pb-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:10px;background:var(--dsw-alias-bg-elevated,#fff);border:1px solid var(--dsw-alias-border-l1,#e6e8ea);box-shadow:0 8px 24px rgba(20,24,28,.14);font-size:13px;color:var(--dsw-alias-label-primary,#242a2d);z-index:80;cursor:pointer}
.pb-model-anchor{position:relative;display:inline-flex;align-items:center;min-width:0}
.pb-model-trigger{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#242a2d);font-size:12.5px;cursor:pointer;line-height:1;transition:background .12s,border-color .12s}
.pb-model-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}
.pb-model-trigger.open{background:var(--dsw-specific-tip,#f3f5f6);border-color:rgba(77,107,254,.55)}
.pb-model-trigger-name{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.pb-model-effort-chip{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a9298);background:var(--dsw-specific-tip,#f3f5f6);border-radius:5px;padding:2px 6px;line-height:1.2}
.pb-model-trigger .pb-icon{color:var(--dsw-alias-label-tertiary,#8a9298);flex:none}
.pb-model-anchor.up .pb-model-popover{top:auto;bottom:calc(100% + 6px)}
.pb-model-popover{position:absolute;right:0;top:calc(100% + 6px);width:280px;max-width:min(92vw,320px);background:var(--dsw-alias-bg-elevated,#fff);border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:12px;box-shadow:0 12px 32px rgba(20,24,28,.16),0 2px 6px rgba(20,24,28,.06);padding:6px;z-index:60;color:var(--dsw-alias-label-primary,#242a2d)}
.pb-menu-row{display:flex;align-items:center;gap:10px;width:100%;height:40px;padding:0 10px;border:0;background:transparent;border-radius:8px;cursor:pointer;font:inherit;font-size:13.5px;color:inherit;text-align:left}
.pb-menu-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}
.pb-menu-row:disabled{cursor:default;opacity:.65}
.pb-menu-row-label{color:var(--dsw-alias-label-secondary,#6f777d);flex:none;min-width:64px}
.pb-menu-row-value{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:188px;color:var(--dsw-alias-label-primary,#242a2d)}
.pb-menu-row .pb-model-chevron{color:var(--dsw-alias-label-tertiary,#8a9298);flex:none}
.pb-menu-back{display:flex;align-items:center;gap:6px;width:100%;height:34px;padding:0 8px;border:0;background:transparent;border-radius:8px;cursor:pointer;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-secondary,#6f777d);text-align:left}
.pb-menu-back:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}
.pb-menu-list{max-height:320px;overflow:auto;padding-bottom:2px}
.pb-menu-group-title{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a9298);padding:8px 8px 4px;line-height:1.3}
.pb-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px;border:0;background:transparent;border-radius:8px;cursor:pointer;text-align:left;font:inherit;font-size:13.5px;color:inherit}
.pb-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}
.pb-menu-item.selected{background:rgba(77,107,254,.09)}
.pb-menu-item:disabled{cursor:default;opacity:.65}
.pb-menu-item-text{display:flex;flex-direction:column;gap:2px;min-width:0;margin-right:auto}
.pb-menu-item-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a9298);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb-menu-empty,.pb-menu-error{padding:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#6f777d)}
.pb-menu-error{color:#c0574d}
.pb-inspector-head{padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8ea)}
.pb-inspector-title{font-size:15px;font-weight:650;margin:0;display:flex;align-items:center;gap:8px;overflow-wrap:anywhere}
.pb-tabs{display:flex;gap:2px;margin-top:10px}
.pb-tab{border:0;background:transparent;padding:6px 10px;border-radius:8px;color:var(--dsw-alias-label-secondary,#6f777d);font-size:12.5px;cursor:pointer;transition:background .12s,color .12s}
.pb-tab[aria-selected=true]{background:var(--dsw-specific-tip,#f3f5f6);color:var(--dsw-alias-label-primary,#242a2d);font-weight:600}
.pb-sec{padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#f0f2f3)}
.pb-sec h3{font-size:12.5px;font-weight:650;margin:0 0 8px;color:var(--dsw-alias-label-secondary,#6f777d);display:flex;align-items:center;gap:6px}
.pb-sec h3 .pb-spacer{flex:1}
.pb-overview-editor{display:flex;align-items:center;gap:8px;margin:0}
.pb-overview-editor>label{flex:none;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#6f777d)}
.pb-overview-editor>.pb-input{flex:1;min-width:0}
.pb-overview-editor>.pb-btn{flex:none}
.pb-scroll{flex:1;overflow:auto;min-height:0}
.pb-row{display:flex;align-items:center;gap:7px;padding:6px 0;border-bottom:1px dashed transparent;min-width:0}
.pb-row-text{flex:1;min-width:0}
.pb-row-title{font-size:13px;line-height:1.4;overflow-wrap:anywhere}
.pb-row-sub{color:var(--dsw-alias-label-tertiary,#8a9298);font-size:11.5px;margin-top:2px;overflow-wrap:anywhere}
.pb-actions{display:flex;gap:3px;flex:none;align-items:center}
.pb-icon-btn{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8a9298);padding:3px;border-radius:5px;display:grid;place-items:center}
.pb-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6);color:var(--dsw-alias-label-primary,#242a2d)}
.pb-empty{color:var(--dsw-alias-label-tertiary,#8a9298);font-size:12.5px;padding:14px 4px;text-align:center}
.pb-empty.big{padding:60px 20px;font-size:13.5px;line-height:1.9}
.pb-input,.pb-select,.pb-textarea{width:100%;border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:inherit;padding:6px 8px;outline:none;font-size:13px}
.pb-input:focus,.pb-select:focus,.pb-textarea:focus{border-color:${PB_ACCENT}}
.pb-kind-trigger{display:flex;align-items:center;gap:8px;min-height:38px;text-align:left}
.pb-kind-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}
.pb-kind-trigger.open{border-color:${PB_ACCENT}}
.pb-kind-trigger:focus-visible{outline:2px solid ${PB_ACCENT};outline-offset:2px}
.pb-kind-trigger>svg{flex:none;color:var(--dsw-alias-label-tertiary,#8a9298)}
.pb-kind-icon{display:grid;place-items:center;width:24px;height:24px;flex:none;border-radius:6px;background:var(--dsw-specific-tip,#f3f5f6)}
.pb-kind-label{flex:1;min-width:0}
.pb-kind-menu{position:fixed;z-index:1000;box-sizing:border-box;overflow:auto;padding:5px;border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:10px;background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,#242a2d);font:inherit;font-size:13px;box-shadow:0 10px 30px rgba(20,24,28,.16),0 2px 6px rgba(20,24,28,.06);scrollbar-width:thin}
.pb-kind-menu *{box-sizing:border-box}
.pb-kind-option{display:flex;align-items:center;gap:9px;width:100%;min-height:38px;padding:6px 8px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.pb-kind-option[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}
.pb-kind-option[aria-selected=true]{background:color-mix(in srgb, ${PB_ACCENT} 8%, transparent)}
.pb-kind-option>svg{flex:none}
.pb-textarea{resize:vertical;min-height:64px;line-height:1.5}
.pb-form{display:flex;flex-direction:column;gap:7px}
.pb-form label{font-size:12px;color:var(--dsw-alias-label-secondary,#6f777d)}
.pb-form-row{display:flex;gap:7px}
.pb-form-row>*{flex:1;min-width:0}
.pb-quick-add{margin:0;min-width:0}
.pb-quick-add .pb-form-row>.pb-btn{flex:0 0 auto;min-width:54px}
.pb-quick-add .pb-input{min-height:32px;border-color:var(--dsw-alias-border-l2,#d8dbde)}
.pb-quick-add[aria-busy=true] .pb-input{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}
.pb-form-error{margin-top:5px;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-danger-label,#c0574d);overflow-wrap:anywhere}
.pb-btn:disabled{cursor:default}
.pb-btn:focus-visible,.pb-icon-btn:focus-visible{outline:2px solid ${PB_ACCENT};outline-offset:2px}
.pb-todo{display:flex;align-items:flex-start;gap:7px;padding:7px 8px;border:1px solid transparent;border-radius:8px;cursor:pointer}
.pb-todo:hover{background:var(--dsw-specific-tip,#f6f8f8)}
.pb-todo.selected{border-color:${PB_ACCENT};background:color-mix(in srgb, ${PB_ACCENT} 6%, transparent)}
.pb-todo-title{font-size:13px;line-height:1.4;overflow-wrap:anywhere}
.pb-todo-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:3px;color:var(--dsw-alias-label-tertiary,#8a9298);font-size:11px}
.pb-drawer{position:relative;flex:1;min-height:0;min-width:0;width:100%;background:var(--dsw-alias-bg-base,#fff);display:flex;flex-direction:column}
.pb-drawer-head{padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8ea);display:flex;align-items:flex-start;gap:8px;flex:none;max-height:45%;overflow:auto}
.pb-native-conversation{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;overflow:hidden;position:relative}
.pb-native-conversation>div{min-height:0}
.pb-context{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#6f777d)}
.pb-context summary{cursor:pointer;line-height:1.6}
.pb-context pre{margin:7px 0 0;padding:8px;border-radius:7px;background:var(--dsw-specific-tip,#f3f5f6);font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;line-height:1.6}
.pb-context-notes{margin-top:0;max-height:140px;overflow:auto}
.pb-conversation-start{display:flex;flex:1;align-items:center;justify-content:center;flex-direction:column;padding:18px}
.pb-drawer-foot{flex:none}
.pb-drawer-title{font-size:15px;font-weight:650;margin:0;flex:1;overflow-wrap:anywhere;line-height:1.4}
.pb-thread{flex:1;min-height:0;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:9px;background:var(--dsw-alias-bg-base,#fff)}
.pb-msg{max-width:92%;border-radius:10px;padding:8px 10px;font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.pb-msg.user{align-self:flex-end;background:color-mix(in srgb, ${PB_ACCENT} 10%, transparent);border:1px solid rgba(40,141,119,.18)}
.pb-msg.assistant{align-self:flex-start;background:var(--dsw-specific-tip,#f3f5f6);border:1px solid var(--dsw-alias-border-l1,#e6e8ea)}
.pb-msg .pb-msg-meta{display:block;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a9298);margin-bottom:3px}
.pb-tool{border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:8px;padding:7px 9px;font-size:12px;background:var(--dsw-alias-bg-base,#fff)}
.pb-tool summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#6f777d);display:flex;gap:6px;align-items:center}
.pb-tool pre{margin:6px 0 0;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#6f777d);max-height:180px;overflow:auto}
.pb-note{align-self:center;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a9298)}
.pb-drawer-foot{border-top:1px solid var(--dsw-alias-border-l1,#e6e8ea);padding:10px 16px;display:flex;flex-direction:column;gap:8px}
.pb-drawer-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.pb-modal-mask{position:fixed;inset:0;background:rgba(15,20,24,.38);z-index:40;display:grid;place-items:center;padding:24px}
.pb-modal{width:min(520px,94vw);background:var(--dsw-alias-bg-elevated,#fff);border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:12px;box-shadow:0 16px 50px rgba(10,15,20,.28);padding:16px;display:flex;flex-direction:column;gap:12px;max-height:88vh;overflow:auto}
.pb-modal h3{margin:0;font-size:15px}
.pb-modal-actions{display:flex;justify-content:flex-end;gap:8px}
.pb-preview-mask{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:rgba(15,20,24,.3);backdrop-filter:blur(2px)}
.pb-preview-dialog{position:relative;box-sizing:border-box;display:flex;flex-direction:column;min-width:0;min-height:0;width:min(1100px,100%);height:min(850px,100%);max-width:100%;max-height:100%;overflow:hidden;border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:14px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 16px 60px rgba(10,15,20,.24);outline:none}
.pb-preview-dialog.maximized{width:100%;height:100%}
.pb-preview-dialog.resizing{user-select:none}
.pb-preview-dialog.resizing iframe{pointer-events:none}
.pb-preview-resize{position:absolute;right:0;bottom:0;z-index:2;width:22px;height:22px;padding:0;border:0;border-radius:0 0 13px 0;background:transparent;color:var(--dsw-alias-label-tertiary,#8a9298);cursor:nwse-resize;touch-action:none}
.pb-preview-resize:after{content:'';position:absolute;right:5px;bottom:5px;width:10px;height:10px;background:repeating-linear-gradient(135deg,transparent 0 3px,currentColor 3px 4px);clip-path:polygon(100% 0,100% 100%,0 100%)}
.pb-preview-resize:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}
.pb-preview-resize:focus-visible{outline:2px solid ${PB_ACCENT};outline-offset:-3px}
.pb-preview-head{display:flex;align-items:center;flex-wrap:wrap;gap:10px;flex:none;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8ea)}
.pb-preview-heading{flex:1;min-width:0}
.pb-preview-heading h2{margin:0;font-size:15px;font-weight:600}
.pb-preview-path{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#6f777d);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.pb-preview-nav{display:flex;align-items:center;gap:8px;flex:none;padding:9px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8ea)}
.pb-preview-crumbs{display:flex;align-items:center;gap:5px;min-width:0;overflow:auto;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a9298);font-size:12px}
.pb-preview-crumbs button{padding:3px;border:0;border-radius:5px;background:transparent;font-size:12px;color:var(--dsw-alias-label-secondary,#6f777d)}
.pb-preview-crumbs button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f3f5f6);color:var(--dsw-alias-label-primary,#242a2d)}
.pb-preview-crumbs button:disabled{cursor:default;color:var(--dsw-alias-label-primary,#242a2d)}
.pb-preview-content{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:auto}
.pb-preview-directory{padding:8px 12px}
.pb-preview-entry{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:10px;border:0;border-radius:8px;background:transparent;font-size:13px}
.pb-preview-entry:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}
.pb-preview-entry:disabled{opacity:.5;cursor:default}
.pb-preview-entry-name{min-width:0;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.pb-preview-text{margin:0;min-height:100%;width:max-content;min-width:100%;padding:18px 20px;tab-size:4;white-space:pre;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;line-height:1.65;color:inherit;outline:none}
.pb-preview-markdown{box-sizing:border-box;flex:none;min-width:0;width:100%;padding:20px 28px;font-size:14px;line-height:1.75;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,#242a2d);outline:none}
.pb-preview-markdown img{max-width:100%;height:auto}
.pb-preview-markdown pre{overflow:auto}
.pb-preview-markdown table{max-width:100%}
.pb-preview-markdown:focus-visible{outline:2px solid ${PB_ACCENT};outline-offset:-2px}
.pb-preview-image{display:flex;align-items:center;justify-content:center;min-height:0;height:100%;padding:16px;background:var(--dsw-specific-tip,#f3f5f6)}
.pb-preview-image img{display:block;max-width:100%;max-height:100%;object-fit:contain}
.pb-preview-pdf{display:block;flex:1;min-height:0;width:100%;height:100%;border:0;background:#f3f5f6}
.pb-preview-empty{display:flex;flex:1;align-items:center;justify-content:center;flex-direction:column;padding:32px;gap:12px;text-align:center;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6f777d)}
.pb-preview-note{padding:12px;font-size:12px;color:var(--dsw-alias-label-secondary,#6f777d)}
.pb-preview-foot{display:flex;align-items:center;gap:8px;flex:none;padding:10px 28px 10px 14px;border-top:1px solid var(--dsw-alias-border-l1,#e6e8ea)}
@media(max-width:760px){.pb-preview-mask{padding:8px}.pb-preview-head{padding:10px}.pb-preview-nav{flex-wrap:wrap}.pb-preview-crumbs{width:100%}.pb-preview-text{padding:12px}}
.pb-error{position:absolute;left:50%;top:12px;transform:translateX(-50%);z-index:30;background:#c0574d;color:#fff;border-radius:8px;padding:7px 12px;font-size:12.5px;max-width:80%;box-shadow:0 4px 16px rgba(0,0,0,.2)}
.pb-busy{position:absolute;right:14px;top:10px;z-index:20;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a9298)}
.pb-side-row{display:flex;align-items:center;gap:8px;height:32px;margin:0 12px;padding:0 8px;border-radius:12px;color:var(--dsw-alias-label-primary,#242a2d);font-size:14px;cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden}
.pb-side-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f5f6)}
.pb-side-row:focus-visible{outline:2px solid ${PB_ACCENT};outline-offset:-2px}
.pb-side-row svg{flex:none;opacity:.75}
.pb-side-row .pb-side-badge{margin-left:auto;width:6px;height:6px;border-radius:50%;background:${PB_ACCENT};opacity:.65}

@media(max-width:760px){.pb-header{gap:6px;padding-left:10px;padding-right:10px}.pb-dock-tabs{padding:6px}.pb-drawer-head,.pb-drawer-foot{padding:10px}.pb-thread{padding:10px}}
`;

function pbInjectStyle(ctx) {
  const style = document.createElement('style');
  style.dataset.plugin = 'project-board';
  style.textContent = PB_CSS + PB_EXPLORER_CSS + PB_DELIVERY_CSS;
  document.head.appendChild(style);
  if (ctx && typeof ctx.on === 'function') ctx.on('dispose', () => style.remove());
}
