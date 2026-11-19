#include <stdio.h>

/* 诊断用临时版本：在出错版本上只加一行打印 a[5]，看清第 6 个数去了哪里 */
int main(void)
{
    int a[5];
    int n, i;
    int sum = 0;

    scanf("%d", &n);
    for (i = 0; i < n; i++) {
        scanf("%d", &a[i]);
    }

    printf("a[5] = %d\n", a[5]);

    for (i = 0; i < n; i++) {
        sum += a[i];
    }

    printf("总分 = %d\n", sum);
    printf("平均 = %.2f\n", (double)sum / n);

    return 0;
}
