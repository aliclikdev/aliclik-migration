# create-queues.ps1
param(
    [string]$Region = "us-east-1",
    [string]$AccountId = "417609992114"
)

$ErrorActionPreference = "Stop"
$QueueName = "User-migration-queue-v2"
$DlqName = "user-migration-dlq-v2"

# Función auxiliar para escribir UTF-8 sin BOM (evita fallos de parsing en AWS CLI)
function Write-Utf8NoBom ($filePath, $content) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($filePath, $content, $utf8NoBom)
}

Write-Host "Creating SQS queues in $Region..." -ForegroundColor Green

# 1. Create DLQ
Write-Host "`nCreating DLQ: $DlqName" -ForegroundColor Yellow
$dlqResult = aws sqs create-queue `
    --queue-name $DlqName `
    --region $Region `
    --attributes "VisibilityTimeout=30,MessageRetentionPeriod=1209600"

$dlqUrl = "https://sqs.$Region.amazonaws.com/$AccountId/$DlqName"
Write-Host "DLQ URL: $dlqUrl" -ForegroundColor Green

# 2. Get DLQ ARN
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

# 3. Create main queue using JSON
Write-Host "`nCreating main queue: $QueueName" -ForegroundColor Yellow

# Construimos los objetos directamente y los convertimos a JSON válido
$redrivePolicyObj = @{
    deadLetterTargetArn = $dlqArn
    maxReceiveCount     = 3
} | ConvertTo-Json -Compress

$attributesObj = @{
    VisibilityTimeout      = "30"
    MessageRetentionPeriod = "345600"
    RedrivePolicy          = $redrivePolicyObj
} | ConvertTo-Json

# Guardar en archivo temporal UTF-8 SIN BOM
$tempFile = [System.IO.Path]::GetTempFileName()
Write-Utf8NoBom $tempFile $attributesObj

# Crear la cola principal
aws sqs create-queue `
    --queue-name $QueueName `
    --region $Region `
    --attributes file://$tempFile

Remove-Item $tempFile -Force -ErrorAction SilentlyContinue

$queueUrl = "https://sqs.$Region.amazonaws.com/$AccountId/$QueueName"
Write-Host "Main queue created: $queueUrl" -ForegroundColor Green

# 4. Get main queue ARN
Write-Host "`nGetting main queue ARN..." -ForegroundColor Yellow
$queueArn = aws sqs get-queue-attributes `
    --queue-url $queueUrl `
    --attribute-names QueueArn `
    --region $Region `
    --query 'Attributes.QueueArn' `
    --output text

if ([string]::IsNullOrWhiteSpace($queueArn)) {
    Write-Host "ERROR: Could not get main queue ARN" -ForegroundColor Red
    exit 1
}
Write-Host "Main queue ARN: $queueArn" -ForegroundColor Cyan

# 5. Summary
Write-Host "`n=================================" -ForegroundColor Green
Write-Host "QUEUES CREATED SUCCESSFULLY!" -ForegroundColor Green
Write-Host "=================================" -ForegroundColor Green
Write-Host ""
Write-Host "MAIN QUEUE:" -ForegroundColor Yellow
Write-Host "  URL: $queueUrl" -ForegroundColor White
Write-Host "  ARN: $queueArn" -ForegroundColor White
Write-Host ""
Write-Host "DLQ:" -ForegroundColor Yellow
Write-Host "  URL: $dlqUrl" -ForegroundColor White
Write-Host "  ARN: $dlqArn" -ForegroundColor White
Write-Host ""
Write-Host "=================================" -ForegroundColor Green
Write-Host ""
Write-Host "✅ Your .env variables should be:" -ForegroundColor Green
Write-Host ""
Write-Host "SQS_QUEUE_URL=""$queueUrl""" -ForegroundColor Cyan
Write-Host "SQS_DLQ_URL=""$dlqUrl""" -ForegroundColor Cyan
Write-Host "SQS_QUEUE_ARN=""$queueArn""" -ForegroundColor Cyan
Write-Host "SQS_DLQ_ARN=""$dlqArn""" -ForegroundColor Cyan

# 6. Verify DLQ configuration
Write-Host "`nVerifying DLQ configuration..." -ForegroundColor Yellow
$verifyResult = aws sqs get-queue-attributes `
    --queue-url $queueUrl `
    --attribute-names RedrivePolicy `
    --region $Region

Write-Host "✅ DLQ Configuration verified:" -ForegroundColor Green
Write-Host $verifyResult -ForegroundColor White

# 7. Send test message
Write-Host "`nSending test message..." -ForegroundColor Yellow

$timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.000Z"
$date = Get-Date -Format "yyyyMMdd"
$time = Get-Date -Format "HHmmss"

$testMessageObj = @{
    eventId      = "test-$date-$time"
    eventType    = "CREATE_USER"
    timestamp    = $timestamp
    sourceSystem = "ALICLIK_LEGACY_HEROKU"
    person       = @{
        firstName      = "Test"
        lastName       = "User"
        documentType   = "DNI"
        documentNumber = "99999999"
    }
    user         = @{
        email      = "test-$date@example.com"
        cognitoSub = "test-sub-$date-$time"
        isActive   = $true
    }
    membership   = @{
        storeLegacyId = 65921
        role          = "SELLER"
    }
} | ConvertTo-Json -Depth 3

$msgFile = [System.IO.Path]::GetTempFileName()
Write-Utf8NoBom $msgFile $testMessageObj

aws sqs send-message `
    --queue-url $queueUrl `
    --message-body file://$msgFile `
    --region $Region

Remove-Item $msgFile -Force -ErrorAction SilentlyContinue

Write-Host "`n✅ Done! Test message sent successfully." -ForegroundColor Green