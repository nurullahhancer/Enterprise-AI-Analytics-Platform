export type ConnectorPlatform = 
  | 'EXCEL_CSV'
  | 'TRENDYOL'
  | 'SHOPIFY'
  | 'AMAZON'
  | 'WOOCOMMERCE'
  | 'LOGO'
  | 'PARASUT'
  | 'REST_API';

export interface EComOrderRecord {
  orderId: string;
  channel: string;
  orderDate: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  costPrice: number;
  profitMargin: number;
  customerCity?: string;
  status: 'DELIVERED' | 'SHIPPED' | 'CANCELLED' | 'RETURNED';
}

export interface EComReviewRecord {
  reviewId: string;
  channel: string;
  sku: string;
  rating: number; // 1 to 5
  comment: string;
  createdAt: string;
}

export interface AccountingTransactionRecord {
  transactionId: string;
  date: string;
  type: 'INCOME' | 'EXPENSE' | 'RECEIVABLE' | 'PAYABLE';
  category: string;
  amount: number;
  description: string;
}

export class EComAccountingConnectorManager {
  /**
   * Normalizes incoming raw payloads into standardized EComOrderRecord
   */
  public static normalizeEComOrders(platform: ConnectorPlatform, rawData: any[]): EComOrderRecord[] {
    if (!Array.isArray(rawData)) return [];

    return rawData.map((item, idx) => {
      const orderId = String(item.orderId || item.order_number || item.id || item.siparis_no || `ORD-${idx + 1000}`);
      const channel = platform === 'EXCEL_CSV' ? (item.channel || 'E-Ticaret') : platform;
      const orderDate = String(item.orderDate || item.created_at || item.tarih || new Date().toISOString());
      const sku = String(item.sku || item.product_code || item.barkod || `SKU-${idx + 1}`);
      const productName = String(item.productName || item.title || item.urun_adi || 'Ürün');
      const quantity = Number(item.quantity || item.qty || item.adet || 1);
      const unitPrice = Number(item.unitPrice || item.price || item.birim_fiyat || 0);
      const totalAmount = Number(item.totalAmount || item.total_price || item.tutar || (quantity * unitPrice));
      const costPrice = Number(item.costPrice || item.maliyet || (totalAmount * 0.6));
      const profitMargin = totalAmount > 0 ? (totalAmount - costPrice) / totalAmount : 0;
      const statusStr = String(item.status || item.durum || 'DELIVERED').toUpperCase();

      let status: 'DELIVERED' | 'SHIPPED' | 'CANCELLED' | 'RETURNED' = 'DELIVERED';
      if (statusStr.includes('RETURN') || statusStr.includes('İADE')) status = 'RETURNED';
      else if (statusStr.includes('CANCEL') || statusStr.includes('İPTAL')) status = 'CANCELLED';
      else if (statusStr.includes('SHIP') || statusStr.includes('KARGO')) status = 'SHIPPED';

      return {
        orderId,
        channel,
        orderDate,
        sku,
        productName,
        quantity,
        unitPrice,
        totalAmount,
        costPrice,
        profitMargin,
        customerCity: item.city || item.sehir || 'İstanbul',
        status
      };
    });
  }

  /**
   * Normalizes accounting transactions
   */
  public static normalizeAccountingRecords(rawData: any[]): AccountingTransactionRecord[] {
    if (!Array.isArray(rawData)) return [];

    return rawData.map((item, idx) => {
      const transactionId = String(item.id || item.islem_no || `TRX-${idx + 100}`);
      const date = String(item.date || item.tarih || new Date().toISOString());
      const typeStr = String(item.type || item.tur || 'INCOME').toUpperCase();
      
      let type: 'INCOME' | 'EXPENSE' | 'RECEIVABLE' | 'PAYABLE' = 'INCOME';
      if (typeStr.includes('GIDER') || typeStr.includes('EXPENSE')) type = 'EXPENSE';
      else if (typeStr.includes('ALACAK') || typeStr.includes('RECEIVABLE')) type = 'RECEIVABLE';
      else if (typeStr.includes('BORC') || typeStr.includes('PAYABLE')) type = 'PAYABLE';

      return {
        transactionId,
        date,
        type,
        category: String(item.category || item.kategori || 'Genel'),
        amount: Math.abs(Number(item.amount || item.tutar || 0)),
        description: String(item.description || item.aciklama || '')
      };
    });
  }
}
