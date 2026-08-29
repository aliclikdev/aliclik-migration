# create-queues.ps1
param(
    [string]$Region = "us-east-1",
    [string]$AccountId = "417609992114"
)

$ErrorActionPreference = "Stop"

# ============================================
# 1. COLAS DE MIGRACIÓN (YA EXISTENTES)
# ============================================
$QueueName = "User-migration-queue-v2"
$DlqName = "user-migration-dlq-v2"

Write-Host "Creating SQS queues in $Region..." -ForegroundColor Green

# Función auxiliar para escribir UTF-8 sin BOM
function Write-Utf8NoBom ($filePath, $content) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($filePath, $content, $utf8NoBom)
}

# 1.1 Create DLQ
Write-Host "`nCreating DLQ: $DlqName" -ForegroundColor Yellow
$dlqResult = aws sqs create-queue `
    --queue-name $DlqName `
    --region $Region `
    --attributes "VisibilityTimeout=30,MessageRetentionPeriod=1209600"

$dlqUrl = "https://sqs.$Region.amazonaws.com/$AccountId/$DlqName"
Write-Host "DLQ URL: $dlqUrl" -ForegroundColor Green

# 1.2 Get DLQ ARN
Write-Host "`nGetting DLQ ARN..." -ForegroundColor Yellow
$dlqArn = aws sqs get-queue-attributes `
    --queue-url $dlqUrl `
    --attribute-names QueueArn `
    --region $Region `
    --query 'Attributes.QueueArn' `
    --output text

if ([string]::IsNullOrWhiteSpace($dlqArn)) {
    Write-Host "ERROR: Could not get DLQ ARN" -ForegroundColor Red
    exit 1
}
Write-Host "DLQ ARN: $dlqArn" -ForegroundColor Cyan

# 1.3 Create main queue
Write-Host "`nCreating main queue: $QueueName" -ForegroundColor Yellow

$redrivePolicyObj = @{
    deadLetterTargetArn = $dlqArn
    maxReceiveCount     = 3
} | ConvertTo-Json -Compress

$attributesObj = @{
    VisibilityTimeout      = "30"
    MessageRetentionPeriod = "345600"
    RedrivePolicy          = $redrivePolicyObj
} | ConvertTo-Json

$tempFile = [System.IO.Path]::GetTempFileName()
Write-Utf8NoBom $tempFile $attributesObj

aws sqs create-queue `
    --queue-name $QueueName `
    --region $Region `
    --attributes file://$tempFile

Remove-Item $tempFile -Force -ErrorAction SilentlyContinue

$queueUrl = "https://sqs.$Region.amazonaws.com/$AccountId/$QueueName"
Write-Host "Main queue created: $queueUrl" -ForegroundColor Green

# 1.4 Get main queue ARN
Write-Host "`nGetting main queue ARN..." -ForegroundColor Yellow
$queueArn = aws sqs get-queue-attributes `
    --queue-url $queueUrl `
    --attribute-names QueueArn `
    --region $Region `
    --query 'Attributes.QueueArn' `
    --output text

Write-Host "Main queue ARN: $queueArn" -ForegroundColor Cyan


# ============================================
# 2. 🆕 COLAS DE RESPUESTA PARA NESTJS
# ============================================
Write-Host "`n=========================================" -ForegroundColor Green
Write-Host "CREATING RESPONSE QUEUES FOR NESTJS" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green

$ResponseQueueName = "user-response-queue"
$ResponseDlqName = "user-response-dlq"

# 2.1 Create Response DLQ
Write-Host "`nCreating Response DLQ: $ResponseDlqName" -ForegroundColor Yellow
$respDlqResult = aws sqs create-queue `
    --queue-name $ResponseDlqName `
    --region $Region `
    --attributes "VisibilityTimeout=30,MessageRetentionPeriod=1209600"

$respDlqUrl = "https://sqs.$Region.amazonaws.com/$AccountId/$ResponseDlqName"
Write-Host "Response DLQ URL: $respDlqUrl" -ForegroundColor Green

# 2.2 Get Response DLQ ARN
Write-Host "`nGetting Response DLQ ARN..." -ForegroundColor Yellow
$respDlqArn = aws sqs get-queue-attributes `
    --queue-url $respDlqUrl `
    --attribute-names QueueArn `
    --region $Region `
    --query 'Attributes.QueueArn' `
    --output text

Write-Host "Response DLQ ARN: $respDlqArn" -ForegroundColor Cyan

# 2.3 Create Response queue
Write-Host "`nCreating Response queue: $ResponseQueueName" -ForegroundColor Yellow

$respRedrivePolicyObj = @{
    deadLetterTargetArn = $respDlqArn
    maxReceiveCount     = 5  # Más reintentos para respuestas
} | ConvertTo-Json -Compress

$respAttributesObj = @{
    VisibilityTimeout      = "30"
    MessageRetentionPeriod = "86400"  # 1 día (respuestas no necesitan tanto tiempo)
    RedrivePolicy          = $respRedrivePolicyObj
} | ConvertTo-Json

$respTempFile = [System.IO.Path]::GetTempFileName()
Write-Utf8NoBom $respTempFile $respAttributesObj

aws sqs create-queue `
    --queue-name $ResponseQueueName `
    --region $Region `
    --attributes file://$respTempFile

Remove-Item $respTempFile -Force -ErrorAction SilentlyContinue

$respQueueUrl = "https://sqs.$Region.amazonaws.com/$AccountId/$ResponseQueueName"
Write-Host "Response queue created: $respQueueUrl" -ForegroundColor Green

# 2.4 Get Response queue ARN
Write-Host "`nGetting Response queue ARN..." -ForegroundColor Yellow
$respQueueArn = aws sqs get-queue-attributes `
    --queue-url $respQueueUrl `
    --attribute-names QueueArn `
    --region $Region `
    --query 'Attributes.QueueArn' `
    --output text

Write-Host "Response queue ARN: $respQueueArn" -ForegroundColor Cyan


# ============================================
# 3. SUMMARY FINAL
# ============================================
Write-Host "`n=========================================" -ForegroundColor Green
Write-Host "QUEUES CREATED SUCCESSFULLY!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green

Write-Host "`n📦 MIGRATION QUEUES:" -ForegroundColor Yellow
Write-Host "  Main Queue URL: $queueUrl" -ForegroundColor White
Write-Host "  Main Queue ARN: $queueArn" -ForegroundColor White
Write-Host "  DLQ URL: $dlqUrl" -ForegroundColor White
Write-Host "  DLQ ARN: $dlqArn" -ForegroundColor White

Write-Host "`n📬 RESPONSE QUEUES (para NestJS):" -ForegroundColor Yellow
Write-Host "  Response Queue URL: $respQueueUrl" -ForegroundColor White
Write-Host "  Response Queue ARN: $respQueueArn" -ForegroundColor White
Write-Host "  Response DLQ URL: $respDlqUrl" -ForegroundColor White
Write-Host "  Response DLQ ARN: $respDlqArn" -ForegroundColor White

# ============================================
# 4. ENV VARIABLES
# ============================================
Write-Host "`n=========================================" -ForegroundColor Green
Write-Host "✅ YOUR .env VARIABLES:" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green

Write-Host "`n# Migration Queues" -ForegroundColor Cyan
Write-Host "SQS_QUEUE_URL=""$queueUrl""" -ForegroundColor Cyan
Write-Host "SQS_DLQ_URL=""$dlqUrl""" -ForegroundColor Cyan
Write-Host "SQS_QUEUE_ARN=""$queueArn""" -ForegroundColor Cyan
Write-Host "SQS_DLQ_ARN=""$dlqArn""" -ForegroundColor Cyan

Write-Host "`n# Response Queues (NestJS)" -ForegroundColor Cyan
Write-Host "USER_RESPONSE_QUEUE_URL=""$respQueueUrl""" -ForegroundColor Cyan
Write-Host "USER_RESPONSE_QUEUE_ARN=""$respQueueArn""" -ForegroundColor Cyan
Write-Host "USER_RESPONSE_DLQ_URL=""$respDlqUrl""" -ForegroundColor Cyan
Write-Host "USER_RESPONSE_DLQ_ARN=""$respDlqArn""" -ForegroundColor Cyan

Write-Host "`n=========================================" -ForegroundColor Green

# ============================================
# 5. TEST: Enviar mensaje de prueba a la cola de respuesta
# ============================================
Write-Host "`n📤 Sending test message to response queue..." -ForegroundColor Yellow

$testMessageObj = @{
    eventId = "test-response-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    status = "SUCCESS"
    data = @{
        user = @{
            id = "test-user-id"
            email = "test@example.com"
            cognitoSub = "test-sub"
            isActive = $true
        }
    }
} | ConvertTo-Json -Depth 3

$testFile = [System.IO.Path]::GetTempFileName()
Write-Utf8NoBom $testFile $testMessageObj

aws sqs send-message `
    --queue-url $respQueueUrl `
    --message-body file://$testFile `
    --region $Region

Remove-Item $testFile -Force -ErrorAction SilentlyContinue

Write-Host "`n✅ Done! Test message sent successfully." -ForegroundColor Green

# ============================================
# 6. MOSTRAR COMANDOS ÚTILES
# ============================================
Write-Host "`n📋 Useful commands:" -ForegroundColor Yellow
Write-Host "  # Ver mensajes en cola de respuesta"
Write-Host "  aws sqs receive-message --queue-url $respQueueUrl --region $Region"
Write-Host ""
Write-Host "  # Ver estadísticas de la cola"
Write-Host "  aws sqs get-queue-attributes --queue-url $respQueueUrl --attribute-names ApproximateNumberOfMessages --region $Region"
Write-Host ""
Write-Host "  # Purge queue (eliminar todos los mensajes)"
Write-Host "  aws sqs purge-queue --queue-url $respQueueUrl --region $Region"