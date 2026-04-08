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
            <td>${carton.serial}</td>
            <td>${carton.cartonSerial}</td>
            <td>${carton.processName || "-"}</td>
            <td>${carton.deviceCount}</td>
          </tr>
        `
      )
      .join("");

    const imeiRows = payload.includeImeiList
      ? payload.devices
          .map(
            (device, index) => `
              <tr>
                <td>${index + 1}</td>
                <td>${device.cartonSerial}</td>
                <td>${device.serialNo}</td>
                <td>${device.imeiNo || "-"}</td>
              </tr>
            `
          )
          .join("")
      : "";

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Gate Pass ${payload.gatePassNumber}</title>
          <style>
            * { box-sizing: border-box; }
            @page { size: A4; margin: 14mm; }
            body {
              font-family: Arial, sans-serif;
              color: #0f172a;
              margin: 0;
              background: #ffffff;
            }
            h1, h2, h3, p { margin: 0; }
            .sheet {
              width: 100%;
              max-width: 190mm;
              margin: 0 auto;
            }
            .header {
              display: grid;
              grid-template-columns: minmax(0, 1fr) 210px;
              gap: 18px;
              align-items: stretch;
              border-bottom: 2px solid #0f172a;
              padding-bottom: 14px;
            }
            .header-main {
              display: flex;
              flex-direction: column;
              justify-content: space-between;
              gap: 12px;
            }
            .eyebrow {
              font-size: 11px;
              font-weight: 700;
              letter-spacing: 0.24em;
              text-transform: uppercase;
              color: #64748b;
            }
            .title {
              font-size: 34px;
              font-weight: 800;
              letter-spacing: -0.03em;
              color: #0f172a;
            }
            .subtitle {
              font-size: 14px;
              color: #334155;
              max-width: 520px;
              line-height: 1.5;
            }
            .header-meta {
              display: grid;
              grid-template-columns: repeat(2, minmax(0, 1fr));
              gap: 10px;
            }
            .meta-card,
            .info-card,
            .total-card {
              border: 1px solid #cbd5e1;
              border-radius: 12px;
              padding: 12px;
              background: #ffffff;
            }
            .meta-label,
            .info-label,
            .total-label {
              font-size: 10px;
              font-weight: 700;
              letter-spacing: 0.16em;
              text-transform: uppercase;
              color: #64748b;
              margin-bottom: 6px;
            }
            .meta-value {
              font-size: 16px;
              font-weight: 700;
              color: #0f172a;
              line-height: 1.4;
              word-break: break-word;
            }
            .qr-card {
              border: 1px solid #cbd5e1;
              border-radius: 16px;
              padding: 14px;
              background: linear-gradient(180deg, #f8fafc 0%, #ffffff 100%);
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: space-between;
              min-height: 100%;
            }
            .qr-card img {
              width: 148px;
              height: 148px;
              object-fit: contain;
              border: 1px solid #e2e8f0;
              border-radius: 10px;
              padding: 6px;
              background: #ffffff;
            }
            .qr-caption {
              width: 100%;
              margin-top: 10px;
              text-align: center;
            }
            .qr-caption .meta-label { margin-bottom: 4px; }
            .qr-dispatch-id {
              font-size: 12px;
              font-weight: 700;
              color: #0f172a;
              word-break: break-all;
            }
            .section {
              margin-top: 18px;
            }
            .section-title {
              font-size: 15px;
              font-weight: 800;
              color: #0f172a;
              margin-bottom: 10px;
            }
            .info-grid {
              display: grid;
              grid-template-columns: repeat(3, minmax(0, 1fr));
              gap: 10px;
            }
            .info-value {
              font-size: 13px;
              font-weight: 600;
              color: #0f172a;
              line-height: 1.45;
              word-break: break-word;
            }
            table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 10px;
            }
            th, td {
              border: 1px solid #cbd5e1;
              padding: 9px 10px;
              text-align: left;
              font-size: 12px;
              vertical-align: top;
            }
            th {
              background: #f8fafc;
              text-transform: uppercase;
              letter-spacing: 0.04em;
              font-size: 10px;
              color: #475569;
            }
            .totals {
              margin-top: 12px;
              display: grid;
              grid-template-columns: repeat(2, minmax(0, 220px));
              gap: 10px;
              justify-content: end;
            }
            .total-value {
              font-size: 20px;
              font-weight: 800;
              color: #0f172a;
            }
            .footer {
              margin-top: 36px;
              display: grid;
              grid-template-columns: repeat(3, minmax(0, 1fr));
              gap: 24px;
            }
            .signature {
              border-top: 1px solid #94a3b8;
              padding-top: 8px;
              font-size: 12px;
              color: #334155;
            }
            @media print {
              body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
              .sheet { max-width: none; }
            }
          </style>
        </head>
        <body>
          <div class="sheet">
            <div class="header">
              <div class="header-main">
                <div>
                  <div class="eyebrow">Dispatch Clearance</div>
                  <div class="title">Gate Pass</div>
                  <p class="subtitle">Authorized movement document for finished goods dispatch. Verify gate pass number and dispatch ID before release.</p>
                </div>
                <div class="header-meta">
                  <div class="meta-card">
                    <div class="meta-label">Gate Pass No</div>
                    <div class="meta-value">${payload.gatePassNumber}</div>
                  </div>
                  <div class="meta-card">
                    <div class="meta-label">Invoice No</div>
                    <div class="meta-value">${payload.invoiceNumber}</div>
                  </div>
                  <div class="meta-card">
                    <div class="meta-label">Dispatch Date</div>
                    <div class="meta-value">${dispatchDate || "-"}</div>
                  </div>
                  <div class="meta-card">
                    <div class="meta-label">Company Name</div>
                    <div class="meta-value">${payload.customerName || "-"}</div>
                  </div>
                </div>
              </div>
              <div class="qr-card">
                <img src="${qrCodeUrl}" alt="Dispatch QR Code" />
                <div class="qr-caption">
                  <div class="meta-label">Dispatch ID</div>
                  <div class="qr-dispatch-id">${payload.dispatchId || "-"}</div>
                </div>
              </div>
            </div>

            <div class="section">
              <div class="section-title">Dispatch Information</div>
              <div class="info-grid">
                <div class="info-card">
                  <div class="info-label">Contact Person</div>
                  <div class="info-value">${payload.contactPerson || "-"}</div>
                </div>
                <div class="info-card">
                  <div class="info-label">Phone Number</div>
                  <div class="info-value">${payload.customerPhone || "-"}</div>
                </div>
                <div class="info-card">
                  <div class="info-label">Email</div>
                  <div class="info-value">${payload.customerEmail || "-"}</div>
                </div>
                <div class="info-card">
                  <div class="info-label">E-Way Bill No</div>
                  <div class="info-value">${payload.ewayBillNo || "-"}</div>
                </div>
                <div class="info-card">
                  <div class="info-label">Transporter Name</div>
                  <div class="info-value">${payload.logisticsDetails?.transporterName || "-"}</div>
                </div>
                <div class="info-card">
                  <div class="info-label">Transport Mode</div>
                  <div class="info-value">${payload.logisticsDetails?.transportMode || "-"}</div>
                </div>
                <div class="info-card">
                  <div class="info-label">Vehicle Number</div>
                  <div class="info-value">${payload.logisticsDetails?.vehicleNumber || "-"}</div>
                </div>
                <div class="info-card">
                  <div class="info-label">LR / Reference No</div>
                  <div class="info-value">${payload.logisticsDetails?.referenceNumber || "-"}</div>
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
                <div class="total-value">${payload.cartonCount}</div>
              </div>
              <div class="total-card">
                <div class="total-label">Total Quantity</div>
                <div class="total-value">${payload.totalQuantity}</div>
              </div>
            </div>

          ${
            payload.includeImeiList
              ? `
                <div class="section">
                  <div class="section-title">IMEI Annex</div>
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Carton</th>
                        <th>Serial No</th>
                        <th>IMEI</th>
                      </tr>
                    </thead>
                    <tbody>${imeiRows}</tbody>
                  </table>
                </div>
              `
              : ""
          }

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
