#include <stdio.h>

int main(void)
{
    int a[20];
    int n, i;
    int sum = 0;

    scanf("%d", &n);
    for (i = 0; i < n; i++) {
        scanf("%d", &a[i]);
    }

    for (i = 0; i < n; i++) {
        sum += a[i];
    }

    printf("总分 = %d\n", sum);
    printf("平均（写法一 sum / n） = %d\n", sum / n);
    printf("平均（写法二 (double)sum / n） = %.2f\n", (double)sum / n);

    return 0;
}
