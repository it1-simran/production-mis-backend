class WarrantyService {
  getWarrantyMonths() {
    const value = Number.parseInt(process.env.DEFAULT_WARRANTY_MONTHS || "12", 10);
    return Number.isFinite(value) && value > 0 ? value : 12;
  }

  calculateWarrantyDates(dispatchDate) {
    const startDate = new Date(dispatchDate);
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + this.getWarrantyMonths());
    return {
      warrantyMonths: this.getWarrantyMonths(),
      warrantyStartDate: startDate,
      warrantyEndDate: endDate,
    };
  }
}

module.exports = WarrantyService;
