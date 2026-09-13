import { CheckCircleOutlined, DownloadOutlined, InboxOutlined, UploadOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Divider, Progress, Radio, Space, Table, Upload } from 'antd'
import type { UploadFile } from 'antd'
import { useState } from 'react'
import { api, getErrorMessage } from '../../api'

type ImportType = 'customers' | 'orders'
type ImportResult = { total: number; successCount: number; failureCount: number; errors: Array<{ row: number; reason: string }> }

export const ImportPage = () => {
  const { message } = App.useApp()
  const [type, setType] = useState<ImportType>('customers')
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const downloadTemplate = async (templateType: ImportType) => {
    try {
      const response = await api.get<Blob>('/imports/template', { params: { type: templateType }, responseType: 'blob' })
      const url = URL.createObjectURL(response.data)
      const link = document.createElement('a')
      link.href = url
      link.download = templateType === 'customers' ? '客户导入模板.xlsx' : '订单导入模板.xlsx'
      link.click()
      URL.revokeObjectURL(url)
    } catch (error) { message.error(getErrorMessage(error)) }
  }

  const startImport = async () => {
    const file = fileList[0]?.originFileObj
    if (!file) { message.warning('请先选择 Excel 文件'); return }
    setUploading(true)
    setResult(null)
    setImportError(null)
    try {
      const formData = new FormData()
      formData.append('type', type)
      formData.append('file', file)
      const { data } = await api.post<ImportResult>('/imports', formData, { headers: { 'Content-Type': 'multipart/form-data' } })
      setResult(data)
      setFileList([])
      message.success(`导入完成，成功 ${data.successCount} 条`)
    } catch (error) { const text = getErrorMessage(error, 'Excel 文件导入失败，请检查文件格式后重试'); setImportError(text); message.error(text) }
    finally { setUploading(false) }
  }

  return (
    <div className="content-stack">
      <section className="page-intro compact"><div><div className="eyebrow">批量导入 · 校验结果</div><h2>Excel 批量导入</h2><p>按模板整理数据，系统会逐行校验并返回失败原因。</p></div></section>
      <Card className="import-card" variant="borderless"><div className="import-step"><div className="step-index">01</div><div><h3>选择导入类型</h3><p>客户与订单分开导入，统一使用客户ID和客户组队码识别客户。</p><Radio.Group value={type} onChange={(event) => { setType(event.target.value); setResult(null) }} optionType="button" buttonStyle="solid" options={[{ label: '客户信息', value: 'customers' }, { label: '订单信息', value: 'orders' }]} /></div></div><Divider /><div className="import-step"><div className="step-index">02</div><div className="import-action-copy"><h3>下载模板并填写</h3><p>{type === 'customers' ? '必填字段：客户ID、客户组队码。客户ID不能重复。' : '必填字段：客户ID、客户组队码、服务套餐名称、订单金额。'}</p><Space wrap><Button icon={<DownloadOutlined />} onClick={() => void downloadTemplate(type)}>下载{type === 'customers' ? '客户' : '订单'}模板</Button><Button type="link" onClick={() => void downloadTemplate(type === 'customers' ? 'orders' : 'customers')}>{type === 'customers' ? '下载订单模板' : '下载客户模板'}</Button></Space></div></div><Divider /><div className="import-step"><div className="step-index">03</div><div className="import-upload-zone"><h3>上传文件并校验</h3><Upload.Dragger accept=".xlsx" maxCount={1} fileList={fileList} beforeUpload={() => false} onChange={({ fileList: nextList }) => setFileList(nextList.slice(-1))} onRemove={() => setFileList([])}><p className="ant-upload-drag-icon"><InboxOutlined /></p><p className="ant-upload-text">点击或拖拽 Excel 到这里</p><p className="ant-upload-hint">单个文件不超过 8MB，仅支持 .xlsx</p></Upload.Dragger><Button type="primary" icon={<UploadOutlined />} loading={uploading} onClick={() => void startImport()} className="import-submit">开始校验并导入</Button></div></div></Card>
      {importError && <Alert className="import-error" type="error" showIcon title="Excel 导入失败" description={importError} closable onClose={() => setImportError(null)} />}
      {result && <Card className="import-result" variant="borderless"><div className="result-head"><div><CheckCircleOutlined className="result-icon" /><strong>导入结果</strong></div><span>{result.total} 行数据已处理</span></div><div className="result-progress"><Progress percent={result.total ? Math.round(result.successCount / result.total * 100) : 0} strokeColor="#3d8b6d" format={() => `${result.successCount} / ${result.total} 成功`} /><div className="result-counts"><span className="success-text">成功 {result.successCount}</span><span className="error-text">失败 {result.failureCount}</span></div></div>{result.errors.length > 0 ? <><Alert type="warning" showIcon title="以下行未导入，请修正后再次上传" /><Table size="small" rowKey="row" pagination={false} dataSource={result.errors} columns={[{ title: '行号', dataIndex: 'row', width: 100 }, { title: '失败原因', dataIndex: 'reason' }]} /></> : <Alert type="success" showIcon title="全部数据已成功导入" />}</Card>}
    </div>
  )
}
