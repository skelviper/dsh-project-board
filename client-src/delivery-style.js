// 验收、交付与历史的局部样式，由入口统一注入。
const PB_DELIVERY_CSS = `
.pb-delivery{min-width:0;margin:5px 0 8px;font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.pb-delivery-readout{margin:5px 0}
.pb-field-caption{display:block;margin-bottom:2px;font-size:11px;color:var(--dsw-alias-text-secondary,#69757a)}
.pb-delivery-meta,.pb-delivery-actions{display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin:5px 0}
.pb-delivery-meta .pb-chip{font-size:11px}
.pb-delivery-details>summary,.pb-original-text>summary{cursor:pointer;color:var(--dsw-alias-text-secondary,#69757a);font-size:11px;padding:3px 0;user-select:none}
.pb-delivery-details>summary:focus-visible,.pb-original-text>summary:focus-visible{outline:2px solid var(--dsw-alias-onboarding-accent,#3964fe);outline-offset:2px;border-radius:3px}
.pb-delivery-form{display:flex;flex-direction:column;gap:8px;padding:8px;margin-top:4px;border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:7px;background:var(--dsw-specific-tip,#f7f9f9)}
.pb-delivery-form label{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:12px}
.pb-delivery-form textarea{width:100%;box-sizing:border-box;min-height:62px;resize:vertical;line-height:1.5}
.pb-delivery-form select{width:100%;min-width:0;box-sizing:border-box}
.pb-delivery-selects{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.pb-primary-artifact{display:flex;align-items:baseline;flex-wrap:wrap;gap:5px;max-width:100%;border:0;background:transparent;color:var(--dsw-alias-onboarding-accent,#3964fe);padding:3px 0;text-align:left;font:inherit;cursor:pointer;overflow-wrap:anywhere}
.pb-primary-artifact:disabled{cursor:default}
.pb-primary-label{display:inline-block;flex:none;border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:4px;padding:0 4px;margin-right:5px;color:var(--dsw-alias-onboarding-accent,#3964fe);font-size:11px;line-height:1.6}
.pb-summary-brief{overflow-wrap:anywhere;white-space:pre-wrap}
.pb-original-text{margin-top:2px}
.pb-full-text{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:5px;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l1,#e6e8ea);font-size:12px;line-height:1.55;user-select:text}
.pb-overview-original{padding-top:0!important}
.pb-membership-editor{margin-top:6px}
.pb-membership-form{display:flex;gap:6px;align-items:center;margin-top:5px}
.pb-membership-form .pb-select{flex:1;min-width:0;width:0}
.pb-membership-form .pb-btn{flex:none}
.pb-unassigned{color:var(--dsw-alias-text-secondary,#69757a);font-weight:600}
.pb-change-row{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8ea);font-size:12px;overflow-wrap:anywhere}
.pb-change-row>.pb-expandable-text{width:100%}
.pb-change-row:last-of-type{border-bottom:0}
.pb-change-history .pb-form-error,.pb-membership-editor .pb-form-error,.pb-delivery .pb-form-error{margin-top:6px;white-space:pre-wrap}
.pb-maintenance-toolbar,.pb-maintenance-actions,.pb-maintenance-heading,.pb-maintenance-record-head{display:flex;align-items:center;flex-wrap:wrap;gap:7px}
.pb-maintenance-panel{order:1;flex:0 0 100%;width:100%;min-width:0;max-height:min(48vh,460px);overflow:auto;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1,#e6e8ea);border-radius:10px;background:var(--dsw-alias-bg-base,#fff);font-size:12px;line-height:1.55}
.pb-maintenance-heading>strong{font-size:13px}.pb-maintenance-summary{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}.pb-maintenance-notice{margin:6px 0;color:var(--dsw-alias-onboarding-accent,#3964fe)}
.pb-maintenance-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.pb-maintenance-section{min-width:0}.pb-maintenance-section h3{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;margin:9px 0}
.pb-maintenance-conflict,.pb-maintenance-record{padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8ea);min-width:0;overflow-wrap:anywhere}.pb-maintenance-record-head strong{flex:1;min-width:0;font-weight:600}.pb-maintenance-reason{margin:5px 0;white-space:pre-wrap}.pb-maintenance-actions{margin-top:7px}
.pb-maintenance-compare{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:7px 0}.pb-maintenance-compare>div{min-width:0}.pb-maintenance-compare pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;max-height:150px;overflow:auto;margin:0;padding:7px 8px;border-radius:6px;background:var(--dsw-specific-tip,#f7f9f9);border:1px solid var(--dsw-alias-border-l1,#e6e8ea);user-select:text}
.pb-maintenance-config{margin-top:9px}.pb-maintenance-config>summary,.pb-maintenance-files>summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#6f777d);padding:3px 0}.pb-maintenance-config>summary:focus-visible,.pb-maintenance-files>summary:focus-visible{outline:2px solid var(--dsw-alias-onboarding-accent,#3964fe);outline-offset:2px;border-radius:3px}.pb-maintenance-files ul{margin:5px 0;padding-left:19px;overflow-wrap:anywhere}.pb-maintenance-files code,.pb-maintenance-conflict code{font:inherit;user-select:text}
.pb-maintenance-panel label{display:flex;flex-direction:column;gap:4px}.pb-maintenance-panel textarea{width:100%;min-width:0;resize:vertical;line-height:1.5;font-size:12px}.pb-maintenance-notify{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,#e6e8ea)}.pb-maintenance-config form{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin-top:5px;max-width:540px}.pb-maintenance-config form>label{width:100%}.pb-maintenance-panel .pb-form-error .pb-btn{margin-left:7px}.pb-maintenance-panel .pb-row-sub{white-space:pre-wrap}
@media(max-width:900px){.pb-maintenance-grid{grid-template-columns:minmax(0,1fr);gap:8px}.pb-maintenance-panel{padding:10px;max-height:50vh}.pb-maintenance-toolbar{gap:5px}}
`;
