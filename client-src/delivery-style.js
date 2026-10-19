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
`;
