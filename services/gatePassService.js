class GatePassService {
  generateGatePassNumber() {
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const suffix = Math.floor(Math.random() * 900 + 100);
    return `GP-${stamp}-${suffix}`;
  }

  buildPayload(invoice, cartonSnapshots = [], deviceSnapshots = [], options = {}) {
    const includeImeiList = Boolean(options.includeImeiList);
    const dispatchId = String(invoice?._id || "");
    return {
      dispatchId,
      gatePassNumber: invoice.gatePassNumber,
      invoiceNumber: invoice.invoiceNumber,
      dispatchDate: invoice.dispatchDate,
      customerName: invoice.customerName,
      contactPerson: invoice.contactPerson || "",
      customerPhone: invoice.customerPhone || "",
      customerEmail: invoice.customerEmail || "",
      ewayBillNo: invoice.ewayBillNo || "",
      logisticsDetails: invoice.logisticsDetails || {},
      cartonCount: cartonSnapshots.length,
      totalQuantity: cartonSnapshots.reduce((sum, carton) => sum + Number(carton.deviceCount || 0), 0),
      cartons: cartonSnapshots.map((carton, index) => ({
        serial: index + 1,
        cartonSerial: carton.cartonSerial,
        processName: carton.processName || "",
        deviceCount: Number(carton.deviceCount || 0),
      })),
      devices: includeImeiList
        ? deviceSnapshots.map((device) => ({
            serialNo: device.serialNo,
            imeiNo: device.imeiNo || "",
            cartonSerial: device.cartonSerial,
          }))
        : [],
      includeImeiList,
    };
  }

  escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  toDisplayValue(value, fallback = "-") {
    const normalized = String(value ?? "").trim();
    return normalized ? this.escapeHtml(normalized) : fallback;
  }

  buildPrintableHtml(payload) {
    const dispatchDate = payload.dispatchDate
      ? new Date(payload.dispatchDate).toLocaleString("en-GB", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(
      payload.dispatchId || payload.gatePassNumber || payload.invoiceNumber || ""
    )}`;
    const cartonsHtml = payload.cartons
      .map(
        (carton) => `
          <tr>
            <td class="num">${carton.serial}</td>
            <td>${this.toDisplayValue(carton.cartonSerial)}</td>
            <td>${this.toDisplayValue(carton.processName)}</td>
            <td class="num">${Number(carton.deviceCount || 0)}</td>
          </tr>
        `
      )
      .join("") || `<tr><td colspan="4" class="empty-cell">No cartons linked</td></tr>`;

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title></title>
          <style>
            * { box-sizing: border-box; }
            @page { size: A4 portrait; margin: 0; }
            body {
              font-family: "Segoe UI", Arial, sans-serif;
              color: #0f172a;
              margin: 0;
              background: #ffffff;
              font-size: 12px;
            }
            h1, h2, h3, p { margin: 0; }
            .sheet {
              width: 100%;
              max-width: 210mm;
              margin: 0 auto;
              padding: 12mm;
              min-height: 100vh;
            }
            .header-card {
              border: 1px solid #d3dbe8;
              border-radius: 12px;
              padding: 14px;
              background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
              page-break-inside: avoid;
            }
            .header-grid {
              display: grid;
              grid-template-columns: minmax(0, 1fr) 178px;
              gap: 12px;
              align-items: stretch;
            }
            .eyebrow {
              font-size: 10px;
              font-weight: 700;
              letter-spacing: 0.18em;
              text-transform: uppercase;
              color: #475569;
            }
            .title {
              margin-top: 4px;
              font-size: 28px;
              font-weight: 800;
              letter-spacing: -0.02em;
              color: #0f172a;
            }
            .subtitle {
              margin-top: 6px;
              font-size: 12px;
              color: #334155;
              line-height: 1.4;
            }
            .meta-grid {
              margin-top: 12px;
              display: grid;
              grid-template-columns: repeat(2, minmax(0, 1fr));
              gap: 8px;
            }
            .meta-card,
            .info-card,
            .total-card {
              border: 1px solid #d7deea;
              border-radius: 10px;
              padding: 9px 10px;
              background: #ffffff;
            }
            .meta-label,
            .info-label,
            .total-label {
              font-size: 9px;
              font-weight: 700;
              letter-spacing: 0.12em;
              text-transform: uppercase;
              color: #6b7280;
              margin-bottom: 4px;
            }
            .meta-value {
              font-size: 13px;
              font-weight: 700;
              color: #0f172a;
              line-height: 1.35;
              word-break: break-word;
            }
            .qr-card {
              border: 1px solid #d7deea;
              border-radius: 10px;
              padding: 10px;
              background: #ffffff;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: flex-start;
              gap: 8px;
            }
            .qr-card img {
              width: 120px;
              height: 120px;
              object-fit: contain;
              border: 1px solid #d7deea;
              border-radius: 8px;
              padding: 4px;
              background: #ffffff;
            }
            .qr-caption {
              width: 100%;
              text-align: center;
            }
            .qr-caption .meta-label { margin-bottom: 2px; }
            .qr-dispatch-id {
              font-size: 10px;
              font-weight: 700;
              color: #0f172a;
              word-break: break-all;
              line-height: 1.3;
            }
            .section {
              margin-top: 12px;
              page-break-inside: avoid;
            }
            .section-title {
              font-size: 13px;
              font-weight: 800;
              color: #0f172a;
              margin-bottom: 8px;
              letter-spacing: 0.01em;
            }
            .info-grid {
              display: grid;
              grid-template-columns: repeat(3, minmax(0, 1fr));
              gap: 8px;
            }
            .info-value {
              font-size: 12px;
              font-weight: 600;
              color: #0f172a;
              line-height: 1.35;
              word-break: break-word;
            }
            table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 6px;
            }
            th, td {
              border: 1px solid #d7deea;
              padding: 7px 8px;
              text-align: left;
              font-size: 11px;
              vertical-align: top;
            }
            th {
              background: #f1f5fb;
              text-transform: uppercase;
              letter-spacing: 0.04em;
              font-size: 9px;
              color: #475569;
              font-weight: 700;
            }
            tbody tr:nth-child(even) td {
              background: #fbfdff;
            }
            .num {
              width: 52px;
              text-align: center;
              white-space: nowrap;
            }
            .empty-cell {
              text-align: center;
              color: #6b7280;
              font-style: italic;
            }
            .totals {
              margin-top: 8px;
              display: grid;
              grid-template-columns: repeat(2, minmax(0, 220px));
              gap: 8px;
              justify-content: end;
              page-break-inside: avoid;
            }
            .total-value {
              font-size: 18px;
              font-weight: 800;
              color: #0f172a;
            }
            .footer {
              margin-top: 20px;
              display: grid;
              grid-template-columns: repeat(3, minmax(0, 1fr));
              gap: 14px;
              page-break-inside: avoid;
            }
            .signature {
              border-top: 1px solid #94a3b8;
              padding-top: 7px;
              font-size: 11px;
              color: #334155;
            }
            @media print {
              body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
              .sheet { max-width: none; }
              table { page-break-inside: auto; }
              tr, td, th { page-break-inside: avoid; page-break-after: auto; }
              thead { display: table-header-group; }
            }
          </style>
        </head>
        <body>
          <div class="sheet">
            <div class="header-card">
              <div class="header-grid">
                <div>
                  <div class="eyebrow">Dispatch Clearance</div>
                  <div class="title">Gate Pass</div>
                  <p class="subtitle">Finished goods release document. Verify details before handing over material at gate.</p>
                  <div class="meta-grid">
                    <div class="meta-card">
                      <div class="meta-label">Gate Pass No</div>
                      <div class="meta-value">${this.toDisplayValue(payload.gatePassNumber)}</div>
                    </div>
                    <div class="meta-card">
                      <div class="meta-label">Invoice No</div>
                      <div class="meta-value">${this.toDisplayValue(payload.invoiceNumber)}</div>
                    </div>
                    <div class="meta-card">
                      <div class="meta-label">Dispatch Date</div>
                      <div class="meta-value">${this.toDisplayValue(dispatchDate)}</div>
                    </div>
                    <div class="meta-card">
                      <div class="meta-label">Company Name</div>
                      <div class="meta-value">${this.toDisplayValue(payload.customerName)}</div>
                    </div>
                  </div>
                </div>
                <div class="qr-card">
                  <div class="meta-label">Dispatch QR</div>
                  <img src="${qrCodeUrl}" alt="Dispatch QR Code" />
                  <div class="qr-caption">
                    <div class="meta-label">Dispatch ID</div>
                    <div class="qr-dispatch-id">${this.toDisplayValue(payload.dispatchId)}</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="section">
              <div class="section-title">Dispatch Information</div>
              <div class="info-grid">
                <div class="info-card">
                  <div class="info-label">Contact Person</div>
                  <div class="info-value">${this.toDisplayValue(payload.contactPerson)}</div>
                </div>
                <div class="info-card">
                  <div class="info-label">Phone Number</div>
                  <div class="info-value">${this.toDisplayValue(payload.customerPhone)}</div>
                </div>
                <div class="info-card">
                  <div class="info-label">Email</div>
                  <div class="info-value">${this.toDisplayValue(payload.customerEmail)}</div>
                </div>
                <div class="info-card">
                  <div class="info-label">E-Way Bill No</div>
                  <div class="info-value">${this.toDisplayValue(payload.ewayBillNo)}</div>
                </div>
                <div class="info-card">
                  <div class="info-label">Transporter Name</div>
                  <div class="info-value">${this.toDisplayValue(payload.logisticsDetails?.transporterName)}</div>
                </div>
                <div class="info-card">
                  <div class="info-label">Transport Mode</div>
                  <div class="info-value">${this.toDisplayValue(payload.logisticsDetails?.transportMode)}</div>
                </div>
                <div class="info-card">
                  <div class="info-label">Vehicle Number</div>
                  <div class="info-value">${this.toDisplayValue(payload.logisticsDetails?.vehicleNumber)}</div>
                </div>
                <div class="info-card">
                  <div class="info-label">LR / Reference No</div>
                  <div class="info-value">${this.toDisplayValue(payload.logisticsDetails?.referenceNumber)}</div>
                </div>
              </div>
            </div>

            <div class="section">
              <div class="section-title">Carton Summary</div>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Carton</th>
                    <th>Process</th>
                    <th>Qty</th>
                  </tr>
                </thead>
                <tbody>${cartonsHtml}</tbody>
              </table>
            </div>

            <div class="totals">
              <div class="total-card">
                <div class="total-label">Total Cartons</div>
                <div class="total-value">${Number(payload.cartonCount || 0)}</div>
              </div>
              <div class="total-card">
                <div class="total-label">Total Quantity</div>
                <div class="total-value">${Number(payload.totalQuantity || 0)}</div>
              </div>
            </div>

            <div class="footer">
              <div class="signature">Prepared By</div>
              <div class="signature">Checked By</div>
              <div class="signature">Gate Security</div>
            </div>
          </div>
        </body>
      </html>
    `;
  }
}

module.exports = GatePassService;
